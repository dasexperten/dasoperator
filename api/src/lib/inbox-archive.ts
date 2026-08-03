// =============================================================================
// Inbox R2 archive — durable per-mailbox record of sent/received mail.
//
// Layout (bucket: ARCHIVE / "self-learning"):
//   Inbox/<mailbox-address>/sent/<ISO-timestamp>-<uuid>.json       — full record
//   Inbox/<mailbox-address>/received/<ISO-timestamp>-<uuid>.json  — full record
//   Inbox/<mailbox-address>.json                                  — index (see below)
//
// One subfolder per mailbox address (e.g. orders@notify.dasexperten.com,
// sales@dasexperten.de), each holding both directions. dasexperten@gmail.com
// (the Cloudflare/Workspace account owner's personal Gmail) is explicitly
// excluded per Aram — that inbox stays in Gmail only, never archived here.
//
// Index file: one JSON array per mailbox, sitting next to (not inside) that
// mailbox's subfolder, so a UI can list "all mail for X" in a single R2 GET
// instead of paginating env.ARCHIVE.list() over every object. Each entry
// points at its full-record key. Updated via an etag-conditional
// read-modify-write loop (R2 has no atomic append) — a handful of retries
// covers realistic concurrent-send volume for these mailboxes; if all
// retries lose the race, the fallback write still lands the entry, just
// with a small chance of clobbering a different concurrent entry.
//
// Archiving (both the full record and the index update) is always
// best-effort: a failure here must never block or fail the actual
// send/receive path it's attached to.
// =============================================================================

import type { Env } from '../types';
import { linkEmail } from './email-link';

const SKIP_ADDRESSES = new Set(['dasexperten@gmail.com']);
const INDEX_WRITE_ATTEMPTS = 3;

export type MailDirection = 'sent' | 'received';

// origin classifies WHO the message is from in nature, not which mailbox it
// touched — an automated order-confirmation can go out from any address, so
// classification is per-message. trigger names the automation that produced
// an 'auto' message (e.g. "order-confirmation", "form-ack"); null for human.
export type MailOrigin = 'human' | 'auto';

// -----------------------------------------------------------------------------
// Attachments (Owner 2026-07-29: inline logos and attached images were parsed
// and then thrown away, so /emailer had nothing to render).
//
// Binaries live as their own R2 objects next to the record, never inside the
// JSON: a base64 blob in the record would also land in every index read.
//   Inbox/<addr>/<direction>/<recordId>/att/<n>-<filename>
// The record keeps metadata only, so the index stays small.
//
// Caps are deliberate. Cloudflare Email Routing accepts messages up to ~25 MB
// and the Worker parses them in memory; refusing a fat attachment costs one
// unviewable file, while OOM costs the whole letter.
// -----------------------------------------------------------------------------
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** As handed to us by the MIME parser. `content` is the raw body. */
export interface RawAttachment {
  filename?: string | null;
  mimeType?: string;
  disposition?: 'attachment' | 'inline' | null;
  related?: boolean;
  contentId?: string;
  content?: ArrayBuffer | string;
  encoding?: 'base64' | 'utf8';
}

/** What ends up in the archived record — metadata, never bytes. */
export interface ArchivedAttachment {
  id: string;
  key?: string | undefined;
  filename: string;
  mimeType: string;
  size: number;
  /** contentId with the angle brackets stripped, so `cid:` lookups match. */
  contentId?: string | undefined;
  inline: boolean;
  /** Set when the file was too large to store; metadata is kept as a receipt. */
  skipped?: 'too_large' | 'too_many' | 'quota' | 'write_failed' | undefined;
}

function safeFilename(name: string | null | undefined, index: number): string {
  const base = (name || `attachment-${index + 1}`)
    .replace(/[\\/]+/g, '-')
    .replace(/[\u0000-\u001f"'?*<>|]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .trim();
  return (base || `attachment-${index + 1}`).slice(0, 120);
}

/** postal-mime gives `<abc@host>`; HTML references it as `cid:abc@host`. */
function bareContentId(cid: string | undefined): string | undefined {
  if (!cid) return undefined;
  return cid.replace(/^</, '').replace(/>$/, '').trim() || undefined;
}

function attachmentBytes(a: RawAttachment): Uint8Array | null {
  const c = a.content;
  if (!c) return null;
  if (typeof c === 'string') {
    if (a.encoding === 'base64') {
      try {
        const bin = atob(c);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      } catch {
        return null;
      }
    }
    return new TextEncoder().encode(c);
  }
  return new Uint8Array(c);
}

async function storeAttachments(
  env: Env,
  prefix: string,
  raw: RawAttachment[] | undefined
): Promise<ArchivedAttachment[]> {
  if (!raw?.length) return [];
  const out: ArchivedAttachment[] = [];
  let total = 0;

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    const filename = safeFilename(a.filename, i);
    const meta: ArchivedAttachment = {
      id: String(i),
      filename,
      mimeType: a.mimeType || 'application/octet-stream',
      size: 0,
      contentId: bareContentId(a.contentId),
      inline: a.disposition === 'inline' || a.related === true || Boolean(a.contentId),
    };

    if (i >= MAX_ATTACHMENTS) {
      out.push({ ...meta, skipped: 'too_many' });
      continue;
    }
    const bytes = attachmentBytes(a);
    if (!bytes) continue;
    meta.size = bytes.byteLength;

    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      out.push({ ...meta, skipped: 'too_large' });
      continue;
    }
    if (total + bytes.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
      out.push({ ...meta, skipped: 'quota' });
      continue;
    }

    const key = `${prefix}/att/${i}-${filename}`;
    try {
      await env.ARCHIVE.put(key, bytes, { httpMetadata: { contentType: meta.mimeType } });
      total += bytes.byteLength;
      out.push({ ...meta, key });
    } catch (err) {
      console.log(JSON.stringify({
        scope: 'inbox-archive',
        success: false,
        stage: 'attachment',
        key,
        error: err instanceof Error ? err.message : String(err),
      }));
      out.push({ ...meta, skipped: 'write_failed' });
    }
  }

  return out;
}

/**
 * Sender authentication verdict, taken from the Authentication-Results header
 * Cloudflare writes on inbound (HARD_RULES §6.0b, Owner 2026-08-01).
 *
 *  pass  — DMARC passed AND the envelope sender is aligned with the From domain
 *  fail  — an explicit failure was reported
 *  none  — no verdict was present (not a pass; the header may simply be absent)
 *
 * Only `pass` may unlock the Owner-mail privilege. The From header alone
 * grants nothing: it is forgeable in a minute.
 */
export interface MailAuth {
  dmarc: 'pass' | 'fail' | 'none';
  spf: 'pass' | 'fail' | 'none';
  dkim: 'pass' | 'fail' | 'none';
  /** Envelope sender domain equals the From domain. */
  aligned: boolean;
  /** True only when dmarc === 'pass' && aligned. Nothing else is trusted. */
  verified: boolean;
  /** The raw header, kept so a verdict can always be re-read by a human. */
  raw?: string | undefined;
}

export interface ArchiveEmailInput {
  to?: string | string[] | undefined;
  from?: string | undefined;
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  messageId?: string | undefined;
  threadId?: string | undefined;
  origin?: MailOrigin | undefined;
  trigger?: string | undefined;
  auth?: MailAuth | undefined;
  /** Thread tag: issued by us on send, echoed back inside the recipient
   *  address on their reply. The one link that survives any mail provider. */
  plusTag?: string | undefined;
  /** Raw parser output. Stripped before the record is written — bytes go to
   *  their own R2 objects, only metadata stays in the JSON. */
  attachments?: RawAttachment[] | undefined;
}

export interface IndexEntry {
  key: string;
  direction: MailDirection;
  timestamp: string;
  /** Thread tag — see splitPlusTag. Present on both sides of a threaded pair. */
  plusTag?: string | undefined;
  subject: string;
  from?: string | undefined;
  to?: string | string[] | undefined;
  messageId?: string | undefined;
  threadId?: string | undefined;
  origin?: MailOrigin | undefined;
  trigger?: string | undefined;
  auth?: MailAuth | undefined;
  /** Which agent wrote this — the Owner's rule of 2026-07-26. */
  agent?: string | undefined;
  attachmentCount?: number | undefined;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

// -----------------------------------------------------------------------------
// Plus-addressing (Owner 2026-08-03).
//
// Measured that day on 23 real replies: our stored messageId is the Resend API
// id, while a counterparty's In-Reply-To carries the Message-ID that Amazon SES
// assigned in flight. Zero of 23 matched — the edge from our letter to their
// answer never existed, it was only ever guessed from subject and address.
//
// So the thread carries its own name instead: we send with Reply-To
// sales+t7f3k2@…, and the tag comes back inside the recipient address of their
// reply. No provider has a vote in it.
//
// The tag must never become a folder: a reply to sales+t7f3k2@ belongs in
// sales@, next to the letter it answers. Splitting here — the one place every
// letter passes — keeps that true for both directions at once.
// -----------------------------------------------------------------------------
export function splitPlusTag(address: string): { base: string; tag?: string } {
  const addr = normalizeAddress(address);
  const at = addr.lastIndexOf('@');
  if (at < 1) return { base: addr };
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus < 1) return { base: addr };
  const tag = local.slice(plus + 1).trim();
  const base = `${local.slice(0, plus)}@${domain}`;
  return tag ? { base, tag } : { base };
}

async function readIndex(env: Env, indexKey: string): Promise<{ entries: IndexEntry[]; etag?: string }> {
  const existing = await env.ARCHIVE.get(indexKey);
  if (!existing) return { entries: [] };
  let entries: IndexEntry[] = [];
  try {
    const parsed = JSON.parse(await existing.text());
    if (Array.isArray(parsed)) entries = parsed;
  } catch { /* corrupt/empty index — rebuild from this entry onward */ }
  // R2Object.etag is the bare hex digest; httpEtag is the same value quoted
  // for HTTP headers. onlyIf.etagMatches rejects the quoted form.
  return { entries, etag: existing.etag };
}

async function appendToIndex(env: Env, addr: string, entry: IndexEntry): Promise<void> {
  const indexKey = `Inbox/${addr}.json`;

  for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
    const { entries, etag } = await readIndex(env, indexKey);
    entries.push(entry);
    const putOptions = etag
      ? { onlyIf: { etagMatches: etag }, httpMetadata: { contentType: 'application/json' } }
      : { httpMetadata: { contentType: 'application/json' } };

    // put() with a failed onlyIf condition resolves to null (no throw) —
    // that means another writer landed first, so retry against fresh state.
    const result = await env.ARCHIVE.put(indexKey, JSON.stringify(entries), putOptions);
    if (result !== null) return;
  }

  // Final best-effort attempt, unconditional — may lose a concurrent write,
  // but never drops this entry outright.
  const { entries } = await readIndex(env, indexKey);
  entries.push(entry);
  await env.ARCHIVE.put(indexKey, JSON.stringify(entries), { httpMetadata: { contentType: 'application/json' } });
}

// address = the mailbox this record belongs to (the subfolder + index name) —
// for `sent` this is the From address, for `received` the To address.
export async function archiveEmail(
  env: Env,
  direction: MailDirection,
  address: string,
  payload: ArchiveEmailInput
): Promise<void> {
  const split = splitPlusTag(address);
  const addr = split.base;
  if (!addr || SKIP_ADDRESSES.has(addr)) return;
  // A tag riding on the address wins: it is the letter's own evidence.
  // payload.plusTag is what we issued ourselves when sending.
  const plusTag = split.tag || payload.plusTag;

  const timestamp = new Date().toISOString();
  const recordId = `${timestamp}-${crypto.randomUUID()}`;
  const key = `Inbox/${addr}/${direction}/${recordId}.json`;

  // Bytes never enter the record: strip the raw attachments, store them as
  // their own objects, keep metadata. A failure here must not lose the letter.
  const { attachments: rawAttachments, ...rest } = payload;
  let stored: ArchivedAttachment[] = [];
  try {
    stored = await storeAttachments(env, `Inbox/${addr}/${direction}/${recordId}`, rawAttachments);
  } catch (err) {
    console.log(JSON.stringify({
      scope: 'inbox-archive',
      success: false,
      stage: 'attachments',
      address: addr,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  const record = {
    direction,
    address: addr,
    timestamp,
    ...(plusTag ? { plusTag } : {}),
    ...rest,
    ...(stored.length ? { attachments: stored } : {}),
  };

  try {
    await env.ARCHIVE.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
    });
    await appendToIndex(env, addr, {
      key,
      direction,
      timestamp,
      subject: payload.subject,
      from: payload.from,
      to: payload.to,
      messageId: payload.messageId,
      threadId: payload.threadId,
      origin: payload.origin,
      trigger: payload.trigger,
      ...(plusTag ? { plusTag } : {}),
      ...(payload.auth ? { auth: payload.auth } : {}),
      ...(stored.length ? { attachmentCount: stored.filter((a) => a.key).length } : {}),
    });

    // The letter is safely stored — only now do we try to say who it belongs to.
    // One choke point for both directions: a sent letter is as much part of a
    // counterparty's history as a received one. Failure here is swallowed
    // inside linkEmail; the letter is already on disk either way.
    await linkEmail(env, {
      mailKey: key,
      mailbox: addr,
      direction,
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
    });
  } catch (err) {
    console.log(JSON.stringify({
      scope: 'inbox-archive',
      success: false,
      address: addr,
      direction,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// -----------------------------------------------------------------------------
// Read side: turn `cid:` references into data: URIs.
//
// Mail clients reference inline images by Content-ID. The Emailer renders the
// body inside a sandboxed srcDoc iframe with no same-origin access, so it can
// never fetch an authenticated attachment URL — inlining the bytes is the only
// route that works there, and it adds no new public door to the API.
//
// Only images, and only up to a budget: base64 inflates by ~4/3 and this rides
// on a JSON response.
// -----------------------------------------------------------------------------
const MAX_INLINE_BYTES = 3 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function inlineCidImages(
  env: Env,
  html: string,
  attachments: ArchivedAttachment[] | undefined
): Promise<string> {
  if (!html || !attachments?.length) return html;
  const byCid = new Map<string, ArchivedAttachment>();
  for (const a of attachments) {
    if (a.contentId && a.key && a.mimeType.startsWith('image/')) byCid.set(a.contentId, a);
  }
  if (!byCid.size) return html;

  let budget = MAX_INLINE_BYTES;
  const resolved = new Map<string, string>();
  let out = html;

  for (const [cid, att] of byCid) {
    // cid:foo@bar — match inside src="..." / src='...' / bare, case-insensitive.
    const pattern = new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'gi');
    if (!pattern.test(out)) continue;
    pattern.lastIndex = 0;

    if (att.size > budget) continue;
    let uri = resolved.get(cid);
    if (!uri) {
      try {
        const obj = await env.ARCHIVE.get(att.key!);
        if (!obj) continue;
        const bytes = new Uint8Array(await obj.arrayBuffer());
        uri = `data:${att.mimeType};base64,${toBase64(bytes)}`;
        resolved.set(cid, uri);
        budget -= bytes.byteLength;
      } catch {
        continue;
      }
    }
    out = out.replace(pattern, uri);
  }

  return out;
}

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

const SKIP_ADDRESSES = new Set(['dasexperten@gmail.com']);
const INDEX_WRITE_ATTEMPTS = 3;

export type MailDirection = 'sent' | 'received';

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
}

export interface IndexEntry {
  key: string;
  direction: MailDirection;
  timestamp: string;
  subject: string;
  from?: string | undefined;
  to?: string | string[] | undefined;
  messageId?: string | undefined;
  threadId?: string | undefined;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
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
  const addr = normalizeAddress(address);
  if (!addr || SKIP_ADDRESSES.has(addr)) return;

  const timestamp = new Date().toISOString();
  const key = `Inbox/${addr}/${direction}/${timestamp}-${crypto.randomUUID()}.json`;
  const record = { direction, address: addr, timestamp, ...payload };

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

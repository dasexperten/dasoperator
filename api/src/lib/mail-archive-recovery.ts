import type { Env } from '../types';

// Incident 2026-11-02: self-learning data-plane writes fail with 10001,
// although reads work. This overlay uses an already bound, healthy R2 bucket.
// Nothing is deleted from the canonical bucket or existing legacy archive.
export const RECOVERY_PREFIX = 'Recovery/self-learning/mail-v1/';
const DELETED = 'mailRecoveryDeleted';
const rawEnvs = new WeakMap<Env, Env>();
type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;
const scoped = (key: string) => /^(Inbox\/|MailOutbox\/|MailSendRequests\/|MailDraftFiles\/)/.test(key);
const physical = (key: string) => RECOVERY_PREFIX + key;
const deleted = (o: R2Object | null) => o?.customMetadata?.[DELETED] === '1';
const mailboxIndex = (key: string) => /^Inbox\/[^/]+\.json$/.test(key);

function unionIndexes(...arrays: unknown[]): string {
  const entries = new Map<string, Record<string, unknown>>();
  for (const array of arrays) {
    if (!Array.isArray(array) || array.some(e => !e || typeof e.key !== 'string')) throw new Error('Mail index is malformed; recovery refuses to replace it');
    for (const entry of array) entries.set(entry.key, entry);
  }
  return JSON.stringify([...entries.values()].sort((a,b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''))));
}

function withBody<T extends R2ObjectBody>(object: T, text: string): T {
  const response = new Response(text);
  return new Proxy(object, { get(target, prop) {
    if (['text', 'json', 'arrayBuffer', 'blob'].includes(String(prop))) return (response as any)[prop].bind(response);
    if (prop === 'body') return response.body;
    if (prop === 'bodyUsed') return response.bodyUsed;
    if (prop === 'size') return new TextEncoder().encode(text).length;
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function named<T extends R2Object>(object: T, key: string): T {
  return new Proxy(object, { get(target, prop) {
    if (prop === 'key') return key;
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function condition(value: R2Conditional | Headers | undefined): R2Conditional | undefined {
  if (!value || !(value instanceof Headers)) return value;
  const out: R2Conditional = {};
  if (value.has('if-match')) out.etagMatches = value.get('if-match')!;
  if (value.has('if-none-match')) out.etagDoesNotMatch = value.get('if-none-match')!;
  if (value.has('if-modified-since')) out.uploadedAfter = new Date(value.get('if-modified-since')!);
  if (value.has('if-unmodified-since')) out.uploadedBefore = new Date(value.get('if-unmodified-since')!);
  return out;
}

function matches(c: R2Conditional, object: R2Object | null): boolean {
  const has = (text: string) => text.split(',').some(v => v.trim() === '*' ? !!object : v.trim().replace(/^"|"$/g, '') === object?.etag);
  if (c.etagMatches && !has(c.etagMatches)) return false;
  if (c.etagDoesNotMatch && has(c.etagDoesNotMatch)) return false;
  if (c.uploadedBefore && object && object.uploaded > c.uploadedBefore) return false;
  if (c.uploadedAfter && (!object || object.uploaded <= c.uploadedAfter)) return false;
  return true;
}

/** Stable logical keys and atomic leases remain unchanged for mail callers.
 * Recovery is deliberately explicit, never a silent downgrade on any error.
 * Keep it enabled until reconciliation AND a controlled cutover are verified.
 */
export function mailArchiveEnv(env: Env): Env {
  if (env.MAIL_ARCHIVE_RECOVERY !== 'old') return env;
  if (!env.ARCHIVE_OLD) throw new Error('Mail archive recovery bucket is not bound');
  const primary = env.ARCHIVE, recovery = env.ARCHIVE_OLD;
  const proxy = new Proxy(primary, { get(target, prop) {
    if (prop === 'get' || prop === 'head') return async (key: string, options?: R2GetOptions) => {
      if (!scoped(key)) return (target[prop] as Function).call(target, key, options);
      // Head first: a conditional GET can omit custom metadata/body.
      const overlay = await recovery.head(physical(key));
      if (deleted(overlay)) return null;
      if (overlay) {
        const result = prop === 'head' ? overlay : await recovery.get(physical(key), options);
        if (prop === 'get' && result && 'body' in result && mailboxIndex(key) && !options?.range) {
          const canonical = await primary.get(key);
          if (canonical) return named(withBody(result as R2ObjectBody, unionIndexes(await canonical.json(), await (result as R2ObjectBody).json())), key);
        }
        return result ? named(result, key) : null;
      }
      const result = await (target[prop] as Function).call(target, key, options);
      return result;
    };
    if (prop === 'put') return async (key: string, value: R2PutValue, options?: R2PutOptions) => {
      if (!scoped(key)) return target.put(key, value, options);
      // Other seats can still archive via the administrative REST API. Always
      // union both indexes, so an older recovery snapshot cannot hide their
      // newly written canonical entries or any pre-incident history.
      if (mailboxIndex(key)) {
        if (typeof value !== 'string') throw new Error('Mailbox index recovery requires JSON text');
        const [a,b] = await Promise.all([primary.get(key), recovery.get(physical(key))]);
        value = unionIndexes(a ? await a.json() : [], b && !deleted(b) ? await b.json() : [], JSON.parse(value));
      }
      let adjusted = options;
      const c = condition(options?.onlyIf);
      if (c) {
        const overlay = await recovery.head(physical(key));
        const current = deleted(overlay) ? null : overlay || await primary.head(key);
        if (!matches(c, current)) return null;
        // Atomically claim this version in the healthy bucket. A canonical
        // etag is never passed blindly to a previously absent recovery key.
        adjusted = { ...options, onlyIf: overlay ? { etagMatches: overlay.etag } : { etagDoesNotMatch: '*' } };
      }
      const result = await recovery.put(physical(key), value, adjusted);
      return result ? named(result, key) : null;
    };
    if (prop === 'delete') return async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (scoped(key)) await recovery.put(physical(key), '', { customMetadata: { [DELETED]: '1' } });
        else await primary.delete(key);
      }
    };
    if (prop === 'list') return async (options: R2ListOptions = {}) => {
      // Merge sorted logical keys, including tombstones. startAfter makes the
      // cursor independent of page boundaries in either physical bucket.
      const limit = Math.max(1, Math.min(options.limit || 1000, 1000));
      const marker = options.cursor?.startsWith('mail-recovery:') ? decodeURIComponent(options.cursor.slice(14)) : options.startAfter;
      const { cursor: _cursor, startAfter: _startAfter, ...rest } = options;
      const common = { ...rest, limit, include: ['httpMetadata', 'customMetadata'] as ('httpMetadata' | 'customMetadata')[], ...(marker ? { startAfter: marker } : {}) };
      const [a, b] = await Promise.all([
        primary.list({ ...common, ...(!marker && options.cursor ? { cursor: options.cursor } : {}) }),
        recovery.list({ ...common, prefix: physical(options.prefix || ''), ...(marker ? { startAfter: physical(marker) } : {}) }),
      ]);
      const entries = new Map(a.objects.map(o => [o.key, o]));
      for (const o of b.objects) entries.set(o.key.slice(RECOVERY_PREFIX.length), named(o, o.key.slice(RECOVERY_PREFIX.length)));
      const prefixes = new Set([...a.delimitedPrefixes, ...b.delimitedPrefixes.map(p => p.slice(RECOVERY_PREFIX.length))]);
      const ordered = [...new Set([...entries.keys(), ...prefixes])].sort();
      // Consume tombstones as cursor positions, not result objects.
      const consumed = ordered.slice(0, limit);
      const truncated = ordered.length > limit || a.truncated || b.truncated;
      return { objects: consumed.filter(k => entries.has(k) && !deleted(entries.get(k)!)).map(k => entries.get(k)!), delimitedPrefixes: consumed.filter(k => prefixes.has(k)), truncated,
        ...(truncated && consumed.length ? { cursor: 'mail-recovery:' + encodeURIComponent(consumed.at(-1)!) } : {}) };
    };
    if (prop === 'createMultipartUpload' || prop === 'resumeMultipartUpload') return (key: string, ...args: unknown[]) => {
      if (scoped(key)) throw new Error('Multipart mail writes are unavailable during archive recovery; use bounded put');
      return (Reflect.get(target, prop, target) as Function).call(target, key, ...args);
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const wrapped = { ...env, ARCHIVE: proxy };
  rawEnvs.set(wrapped, env);
  return wrapped;
}

/** Copy only; never clear recovery objects while writers are active. Each
 * source version is verified after copy. A later controlled cutover must
 * quiesce writers, reconcile through done=true, verify, then remove the flag.
 * A failed canonical write leaves all recovery bytes and cursor intact.
 */
export async function reconcileMailRecovery(env: Env, cursor?: string) {
  env = rawEnvs.get(env) || env;
  if (!env.ARCHIVE_OLD) throw new Error('Recovery bucket missing');
  const listing = { prefix: RECOVERY_PREFIX, ...(cursor ? { cursor } : {}), limit: 5, include: ['customMetadata', 'httpMetadata'] };
  const page = await env.ARCHIVE_OLD.list(listing);
  let copied = 0, deletedCount = 0;
  for (const object of page.objects) {
    const key = object.key.slice(RECOVERY_PREFIX.length);
    if (!scoped(key)) throw new Error('Unexpected recovery key');
    const source = await env.ARCHIVE_OLD.get(object.key);
    if (!source) throw new Error('Recovery object changed; retry reconciliation');
    const canonical = await env.ARCHIVE.get(key);
    if (deleted(source)) {
      if (canonical && canonical.uploaded > source.uploaded) throw new Error('Newer canonical object conflicts with recovery deletion; review before cutover');
      await env.ARCHIVE.delete(key);
      if (await env.ARCHIVE.head(key)) throw new Error('Canonical delete not verified');
      deletedCount++;
    } else {
      let bytes = await source.arrayBuffer();
      const digest = async (b: ArrayBuffer) => new Uint8Array(await crypto.subtle.digest('SHA-256', b)).toString();
      if (mailboxIndex(key) && canonical) {
        bytes = new TextEncoder().encode(unionIndexes(await canonical.json(), JSON.parse(new TextDecoder().decode(bytes)))).buffer;
      } else if (canonical && canonical.uploaded > source.uploaded && await digest(await canonical.arrayBuffer()) !== await digest(bytes)) {
        throw new Error('Newer canonical object conflicts with recovery version; review before cutover');
      }
      const written = await env.ARCHIVE.put(key, bytes, { ...(source.httpMetadata ? { httpMetadata: source.httpMetadata } : {}), ...(source.customMetadata ? { customMetadata: source.customMetadata } : {}) });
      const verify = await env.ARCHIVE.get(key);
      if (!written || !verify) throw new Error('Canonical recovery write not verified');
      if (await digest(bytes) !== await digest(await verify.arrayBuffer())) throw new Error('Canonical recovery bytes mismatch');
      copied++;
    }
    if ((await env.ARCHIVE_OLD.head(object.key))?.etag !== source.etag) throw new Error('Recovery source changed; rerun reconciliation before cutover');
  }
  return { copied, deleted: deletedCount, done: !page.truncated, cursor: page.truncated ? page.cursor : null, recoveryRetained: true };
}

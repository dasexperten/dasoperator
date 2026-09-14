import type { Env } from '../types';
import type { RawAttachment } from './inbox-archive';

export const DRAFT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DRAFT_FILES_MAX_BYTES = 20 * 1024 * 1024;
export interface DraftFile { id: string; filename: string; mimeType: string; size: number }
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);
function prefix(userId: string, draftId: string) {
  if (!validId(draftId)) throw new Error('Invalid draft identifier');
  return `MailDraftFiles/${encodeURIComponent(userId)}/${draftId}/`;
}
export async function ownsDraft(env: Env, userId: string, draftId: string): Promise<boolean> {
  if (!validId(draftId)) return false;
  return Boolean(await env.DB.prepare('SELECT id FROM email_drafts WHERE id = ? AND user_id = ?').bind(draftId, userId).first());
}
export async function draftFiles(env: Env, userId: string, draftId: string): Promise<DraftFile[]> {
  const base = prefix(userId, draftId);
  const files: DraftFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({ prefix: base, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      if (!object.key.endsWith('.json')) continue;
      const metadata = await env.ARCHIVE.get(object.key);
      if (metadata) files.push(await metadata.json<DraftFile>());
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return files;
}
export async function storeDraftFile(env: Env, userId: string, draftId: string, file: File): Promise<DraftFile> {
  if (file.size > DRAFT_FILE_MAX_BYTES) throw new Error('Maximum file size is 10 MB');
  const previous = await draftFiles(env, userId, draftId);
  if (previous.length >= 20 || previous.reduce((sum, item) => sum + item.size, file.size) > DRAFT_FILES_MAX_BYTES) {
    throw new Error('Maximum 20 attachments and 20 MB total per message');
  }
  const id = crypto.randomUUID();
  const base = `${prefix(userId, draftId)}${id}`;
  const filename = (file.name || 'attachment').replace(/[\\/\u0000-\u001f]/g, '-').slice(0, 120);
  const metadata: DraftFile = { id, filename, mimeType: file.type || 'application/octet-stream', size: file.size };
  await env.ARCHIVE.put(base, await file.arrayBuffer());
  try { await env.ARCHIVE.put(`${base}.json`, JSON.stringify(metadata)); }
  catch (error) { await env.ARCHIVE.delete(base).catch(() => {}); throw error; }
  return metadata;
}
export async function removeDraftFile(env: Env, userId: string, draftId: string, fileId: string): Promise<void> {
  if (!validId(fileId)) throw new Error('Invalid file identifier');
  const base = `${prefix(userId, draftId)}${fileId}`;
  await env.ARCHIVE.delete([base, `${base}.json`]);
}
export async function loadDraftAttachments(env: Env, userId: string, draftId: string, fileIds: string[]): Promise<RawAttachment[]> {
  if (!(await ownsDraft(env, userId, draftId))) throw new Error('Draft not found');
  if (fileIds.length > 20 || new Set(fileIds).size !== fileIds.length) throw new Error('Invalid attachment selection');
  const files = await draftFiles(env, userId, draftId);
  const result: RawAttachment[] = [];
  let total = 0;
  for (const id of fileIds) {
    if (!validId(id)) throw new Error('Invalid file identifier');
    const metadata = files.find((file) => file.id === id);
    if (!metadata) throw new Error('Attachment not found');
    const object = await env.ARCHIVE.get(`${prefix(userId, draftId)}${id}`);
    if (!object) throw new Error('Attachment file is missing');
    total += object.size;
    if (object.size > DRAFT_FILE_MAX_BYTES || total > DRAFT_FILES_MAX_BYTES) throw new Error('Attachments exceed the message size limit');
    result.push({ filename: metadata.filename, mimeType: metadata.mimeType, content: await object.arrayBuffer(), disposition: 'attachment' });
  }
  return result;
}

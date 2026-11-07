import type { Env } from '../types';

// Read through the ERP's normal /api auth gate. The source bucket stays private;
// callers name an existing inbox row, never an arbitrary R2 object key.
export async function serveInboxFile(env: Pick<Env, 'DB' | 'DOCS'>, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT attachment_r2_key, attachment_filename,
      attachment_content_type FROM invoice_inbox WHERE id=? AND deleted_at IS NULL`)
    .bind(id).first<{ attachment_r2_key: string | null; attachment_filename: string | null; attachment_content_type: string | null }>();
  if (!row?.attachment_r2_key) return new Response('File not found', { status: 404 });
  const object = await env.DOCS.get(row.attachment_r2_key);
  if (!object) return new Response('File not found', { status: 404 });
  const rawType = object.httpMetadata?.contentType || row.attachment_content_type || 'application/octet-stream';
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(rawType) ? rawType : 'application/octet-stream';
  const disposition = mime === 'application/pdf' || mime.startsWith('image/') ? 'inline' : 'attachment';
  const filename = (row.attachment_filename || 'document').replace(/[\r\n]/g, '');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(object.body, { headers: {
    'Content-Type': mime,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'private, max-age=60',
    'X-Content-Type-Options': 'nosniff',
  } });
}

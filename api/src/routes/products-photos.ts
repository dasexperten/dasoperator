// =============================================================================
// Phase 5.1 — Product photos (R2-hosted)
// Endpoints:
//   GET    /api/products/:id/images
//   GET    /api/products/:id/images/:imageId/file  (streams bytes from R2)
//   POST   /api/products/:id/images                (multipart upload)
//   PATCH  /api/products/:id/images/:imageId
//   DELETE /api/products/:id/images/:imageId       (soft-delete)
//
// r2_key pattern: products/{PRODUCT_ID_UPPER}/{NNNN}.{ext}
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const productsPhotos = new Hono<{ Bindings: Env }>();

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

// =============================================================================
// GET /api/products/:id/images — list non-deleted images
// =============================================================================
productsPhotos.get('/:id/images', async (c) => {
  const id = c.req.param('id');

  const prod = await c.env.DB.prepare(
    'SELECT id FROM products WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first();
  if (!prod) return fail(c, 404, [{ code: 'product_not_found', message: id }]);

  const result = await c.env.DB.prepare(`
    SELECT
      id, product_id, r2_key, filename, mime_type, size_bytes,
      width, height, caption, display_order, is_primary,
      uploaded_by, uploaded_at, created_at, updated_at
    FROM product_images
    WHERE product_id = ? AND deleted_at IS NULL
    ORDER BY display_order ASC, is_primary DESC, uploaded_at ASC
  `).bind(id).all<{
    id: string;
    product_id: string;
    r2_key: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    is_primary: number;
  }>();

  // Add signed_url field — for now uses our own /file endpoint (public)
  const images = result.results.map((img) => ({
    ...img,
    is_primary: img.is_primary === 1,
    file_url: `/api/products/${id}/images/${img.id}/file`,
  }));

  return ok(c, {
    count: images.length,
    images,
  });
});

// =============================================================================
// GET /api/products/:id/images/:imageId/file — stream R2 object
// =============================================================================
productsPhotos.get('/:id/images/:imageId/file', async (c) => {
  const productId = c.req.param('id');
  const imageId = c.req.param('imageId');

  const img = await c.env.DB.prepare(`
    SELECT r2_key, mime_type, deleted_at FROM product_images
    WHERE id = ? AND product_id = ?
  `).bind(imageId, productId).first<{ r2_key: string; mime_type: string; deleted_at: number | null }>();

  if (!img) {
    return c.text('Image not found', 404);
  }
  if (img.deleted_at !== null) {
    return c.text('Image deleted', 404);
  }

  const obj = await c.env.DOCS.get(img.r2_key);
  if (!obj) {
    return c.text('R2 object missing', 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', img.mime_type);
  headers.set('Cache-Control', 'public, max-age=3600');
  headers.set('etag', obj.httpEtag);

  return new Response(obj.body, { status: 200, headers });
});

// =============================================================================
// POST /api/products/:id/images — multipart upload
// =============================================================================
productsPhotos.post('/:id/images', async (c) => {
  const id = c.req.param('id');

  const prod = await c.env.DB.prepare(
    'SELECT id FROM products WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first<{ id: string }>();
  if (!prod) return fail(c, 404, [{ code: 'product_not_found', message: id }]);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (err) {
    return fail(c, 400, [{
      code: 'invalid_multipart',
      message: 'Body must be multipart/form-data with field "file"',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return fail(c, 422, [{ code: 'missing_file', message: 'Form field "file" must be a File' }]);
  }

  if (!ALLOWED_MIMES.has(file.type)) {
    return fail(c, 415, [{
      code: 'unsupported_mime',
      message: `mime_type ${file.type} not allowed; expected ${[...ALLOWED_MIMES].join(', ')}`,
    }]);
  }
  if (file.size > MAX_BYTES) {
    return fail(c, 413, [{
      code: 'file_too_large',
      message: `File size ${file.size} exceeds limit ${MAX_BYTES} bytes (5MB)`,
    }]);
  }

  // Determine next display_order
  const maxOrderRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(display_order), 0) AS max_order FROM product_images WHERE product_id = ? AND deleted_at IS NULL'
  ).bind(id).first<{ max_order: number }>();
  const nextOrder = (maxOrderRow?.max_order ?? 0) + 1;

  const ext = extFromMime(file.type);
  const productKeyUpper = prod.id.replace('prd_', '').toUpperCase();
  const r2Key = `products/${productKeyUpper}/${pad4(nextOrder)}.${ext}`;

  // Read file body
  const buffer = await file.arrayBuffer();

  // Upload to R2
  try {
    await c.env.DOCS.put(r2Key, buffer, {
      httpMetadata: { contentType: file.type },
    });
  } catch (err) {
    return fail(c, 500, [{
      code: 'r2_put_failed',
      message: 'Failed to upload to R2',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Determine is_primary: 1 if this is the very first image
  const countRow = await c.env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM product_images WHERE product_id = ? AND deleted_at IS NULL'
  ).bind(id).first<{ cnt: number }>();
  const isPrimary = (countRow?.cnt ?? 0) === 0 ? 1 : 0;

  const imageId = `img_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    await c.env.DB.prepare(`
      INSERT INTO product_images (
        id, product_id, r2_key, filename, mime_type, size_bytes,
        width, height, caption, display_order, is_primary,
        uploaded_by, uploaded_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?)
    `).bind(
      imageId, id, r2Key, file.name, file.type, file.size,
      nextOrder, isPrimary, now, now, now
    ).run();
  } catch (err) {
    // Compensating delete from R2 on DB failure
    try { await c.env.DOCS.delete(r2Key); } catch { /* best effort */ }
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to record image metadata',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, {
    id: imageId,
    product_id: id,
    r2_key: r2Key,
    filename: file.name,
    mime_type: file.type,
    size_bytes: file.size,
    display_order: nextOrder,
    is_primary: isPrimary === 1,
    uploaded_at: now,
    file_url: `/api/products/${id}/images/${imageId}/file`,
  }, [`Uploaded ${file.size} bytes to ${r2Key}`]);
});

// =============================================================================
// PATCH /api/products/:id/images/:imageId — update caption/order/primary
// =============================================================================
const patchImageSchema = z.object({
  caption: z.string().nullable().optional(),
  display_order: z.number().int().nonnegative().optional(),
  is_primary: z.boolean().optional(),
});

productsPhotos.patch('/:id/images/:imageId', async (c) => {
  const productId = c.req.param('id');
  const imageId = c.req.param('imageId');

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]); }

  const parsed = patchImageSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;

  const existing = await c.env.DB.prepare(
    'SELECT id FROM product_images WHERE id = ? AND product_id = ? AND deleted_at IS NULL'
  ).bind(imageId, productId).first();
  if (!existing) {
    return fail(c, 404, [{ code: 'image_not_found', message: `${productId}/${imageId}` }]);
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts = [];

  // If is_primary=true, demote all other images for this product
  if (data.is_primary === true) {
    stmts.push(c.env.DB.prepare(
      'UPDATE product_images SET is_primary = 0, updated_at = ? WHERE product_id = ? AND id != ? AND deleted_at IS NULL'
    ).bind(now, productId, imageId));
  }

  // Build dynamic UPDATE
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (data.caption !== undefined) { sets.push('caption = ?'); binds.push(data.caption); }
  if (data.display_order !== undefined) { sets.push('display_order = ?'); binds.push(data.display_order); }
  if (data.is_primary !== undefined) { sets.push('is_primary = ?'); binds.push(data.is_primary ? 1 : 0); }

  if (sets.length === 0) {
    return ok(c, { id: imageId, message: 'No changes' });
  }

  sets.push('updated_at = ?');
  binds.push(now);
  binds.push(imageId);

  stmts.push(c.env.DB.prepare(
    `UPDATE product_images SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds));

  try {
    await c.env.DB.batch(stmts);
  } catch (err) {
    return fail(c, 500, [{
      code: 'update_failed',
      message: 'Failed to update image',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, { id: imageId, updated_at: now });
});

// =============================================================================
// DELETE /api/products/:id/images/:imageId — soft-delete
// =============================================================================
productsPhotos.delete('/:id/images/:imageId', async (c) => {
  const productId = c.req.param('id');
  const imageId = c.req.param('imageId');

  const existing = await c.env.DB.prepare(
    'SELECT id, is_primary FROM product_images WHERE id = ? AND product_id = ? AND deleted_at IS NULL'
  ).bind(imageId, productId).first<{ id: string; is_primary: number }>();
  if (!existing) {
    return fail(c, 404, [{ code: 'image_not_found', message: `${productId}/${imageId}` }]);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    'UPDATE product_images SET deleted_at = ?, updated_at = ? WHERE id = ?'
  ).bind(now, now, imageId).run();

  return ok(c, { id: imageId, deleted_at: now }, ['Image soft-deleted; R2 object retained']);
});

export default productsPhotos;

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { formatSequenceValue } from '../lib/sequence-format';

const sequences = new Hono<{ Bindings: Env }>();

const nextSchema = z.object({
  sequence_id: z.string().min(1),
});

// =============================================================================
// POST /api/sequences/next
// Atomically increments a sequence and returns the issued number + formatted.
//
// Concurrency safety:
//   D1 single-statement UPDATE...RETURNING is atomic. Two parallel requests
//   to the same sequence_id will receive different issued values.
//
// Side effects:
//   sequences.next_number += 1
//   sequences.updated_at = now
//
// Errors:
//   400 invalid_json    — body not JSON
//   422 invalid_body    — body missing sequence_id
//   404 not_found       — sequence_id does not exist
// =============================================================================
sequences.post('/next', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = nextSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const sequenceId = parsed.data.sequence_id;
  const now = Math.floor(Date.now() / 1000);

  // Atomic increment via UPDATE ... RETURNING.
  // Returns the value BEFORE increment (issued) and AFTER (next_after).
  const stmt = c.env.DB.prepare(`
    UPDATE sequences
    SET next_number = next_number + 1,
        updated_at = ?
    WHERE id = ?
    RETURNING
      id,
      next_number - 1 AS issued_number,
      next_number AS next_number_after,
      format_example,
      padding
  `).bind(now, sequenceId);

  const row = await stmt.first<{
    id: string;
    issued_number: number;
    next_number_after: number;
    format_example: string;
    padding: number;
  }>();

  if (!row) {
    return fail(c, 404, [{
      code: 'sequence_not_found',
      message: `Sequence ${sequenceId} not found`,
    }]);
  }

  const formatted = formatSequenceValue(
    row.issued_number,
    row.format_example,
    row.padding
  );

  return ok(c, {
    sequence_id: row.id,
    issued_number: row.issued_number,
    formatted,
    next_number_after: row.next_number_after,
  });
});

// =============================================================================
// GET /api/sequences/peek/:sequence_id
// Returns the current state WITHOUT incrementing. For preview / debugging.
// =============================================================================
sequences.get('/peek/:sequence_id', async (c) => {
  const sequenceId = c.req.param('sequence_id');

  const row = await c.env.DB.prepare(`
    SELECT id, description, next_number, padding, format_example, updated_at
    FROM sequences
    WHERE id = ?
  `).bind(sequenceId).first<{
    id: string;
    description: string;
    next_number: number;
    padding: number;
    format_example: string;
    updated_at: number;
  }>();

  if (!row) {
    return fail(c, 404, [{
      code: 'sequence_not_found',
      message: `Sequence ${sequenceId} not found`,
    }]);
  }

  const wouldFormat = formatSequenceValue(
    row.next_number,
    row.format_example,
    row.padding
  );

  return ok(c, {
    sequence_id: row.id,
    description: row.description,
    next_number: row.next_number,
    would_format: wouldFormat,
    padding: row.padding,
    format_example: row.format_example,
    updated_at: row.updated_at,
  });
});

export default sequences;

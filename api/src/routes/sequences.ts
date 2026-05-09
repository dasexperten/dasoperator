import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { formatSequenceValue, issueNextSequence } from '../lib/sequence-format';

const sequences = new Hono<{ Bindings: Env }>();

const nextSchema = z.object({
  sequence_id: z.string().min(1),
});

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

  const result = await issueNextSequence(c.env.DB, parsed.data.sequence_id);

  if (!result) {
    return fail(c, 404, [{
      code: 'sequence_not_found',
      message: `Sequence ${parsed.data.sequence_id} not found`,
    }]);
  }

  return ok(c, result);
});

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

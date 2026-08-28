// =============================================================================
// Knowledge graph routes — the operator surface over the organizacia corpus.
//
//   GET  /api/knowledge/stats                → what the cache holds, and how old
//   GET  /api/knowledge/graph                → nodes + edges to draw
//        ?seat=<slug>  ?kind=  ?topic=  ?law=  ?q=  ?limit=
//   GET  /api/knowledge/node/:id             → one node, its body, its neighbours
//   GET  /api/knowledge/search?q=            → trigger-line search across the fleet
//   POST /api/knowledge/sync                 → advance the cache by one scope
//        ?scope=seat:<slug> | law            (admin session required)
//
// The cache is never presented as live. Every read carries the commit it was
// built from and the moment it was built; a page that cannot say when its data
// is from cannot claim to be current (HARD_RULES §9c).
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';
import { validateSession } from '../lib/auth';
import {
  headSha, orgTree, rosterFromTree, rosterNames, buildSeat, buildLaw,
  writeScope, recordScopeError, MissingTokenError,
} from '../lib/kg-ingest';

const knowledge = new Hono<{ Bindings: Env }>();

const MAX_LIMIT = 1500;
// D1 caps bound variables at 100 per statement; stay well under it.
const D1_BIND_CHUNK = 90;

function bearer(c: import('hono').Context): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/knowledge/stats
// ---------------------------------------------------------------------------
knowledge.get('/stats', async (c) => {
  try {
    const [byKind, byFamily, sync] = await Promise.all([
      c.env.DB.prepare(`SELECT kind, COUNT(*) AS n FROM kg_nodes GROUP BY kind`).all(),
      c.env.DB.prepare(
        `SELECT family, COUNT(*) AS n FROM kg_nodes
         WHERE kind = 'record' AND family IS NOT NULL GROUP BY family ORDER BY n DESC`
      ).all(),
      c.env.DB.prepare(`SELECT * FROM kg_sync ORDER BY scope`).all(),
    ]);
    const edges = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM kg_edges`).first<{ n: number }>();

    const scopes = (sync.results ?? []) as Array<Record<string, unknown>>;
    const newest = scopes.reduce<number>((acc, s) => Math.max(acc, Number(s.synced_at) || 0), 0);
    const oldest = scopes.length
      ? scopes.reduce<number>((acc, s) => Math.min(acc, Number(s.synced_at) || 0), Number.MAX_SAFE_INTEGER)
      : 0;

    return ok(c, {
      nodes_by_kind: byKind.results ?? [],
      records_by_family: byFamily.results ?? [],
      edges: edges?.n ?? 0,
      scopes,
      // Two dates, not one: a graph whose newest scope is fresh and whose
      // oldest is a week stale is a stale graph, and one number would hide it.
      synced_newest: newest || null,
      synced_oldest: oldest && oldest !== Number.MAX_SAFE_INTEGER ? oldest : null,
      token_bound: Boolean(c.env.ORG_SSOT_TOKEN),
    });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/graph
// ---------------------------------------------------------------------------
knowledge.get('/graph', async (c) => {
  try {
    const seat = c.req.query('seat')?.trim() || null;
    const kind = c.req.query('kind')?.trim() || null;
    const topic = c.req.query('topic')?.trim() || null;
    const law = c.req.query('law')?.trim() || null;
    const q = c.req.query('q')?.trim() || null;
    const limit = Math.min(Number(c.req.query('limit')) || 400, MAX_LIMIT);

    // Step 1 — the entries the filters select. The graph is drawn around these;
    // everything else is pulled in because an edge reaches it.
    const where: string[] = [`kind = 'record'`];
    const bind: unknown[] = [];
    if (seat) { where.push(`seat_slug = ?`); bind.push(seat); }
    if (kind) { where.push(`family = ?`); bind.push(kind); }
    if (q) {
      where.push(`(trigger_line LIKE ? OR label LIKE ? OR body LIKE ?)`);
      const like = `%${q}%`;
      bind.push(like, like, like);
    }
    if (topic) {
      where.push(`id IN (SELECT src FROM kg_edges WHERE kind = 'about' AND dst = ?)`);
      bind.push(`topic:${topic.toLowerCase()}`);
    }
    if (law) {
      where.push(`id IN (SELECT src FROM kg_edges WHERE kind = 'cites' AND dst = ?)`);
      bind.push(`law:${law.toLowerCase().replace(/^§/, '')}`);
    }

    const seed = await c.env.DB
      .prepare(
        `SELECT id, kind, label, seat_slug, family, trigger_line, dated_on, source_file
         FROM kg_nodes WHERE ${where.join(' AND ')}
         ORDER BY dated_on DESC NULLS LAST, label
         LIMIT ?`
      )
      .bind(...bind, limit)
      .all();

    const seeds = (seed.results ?? []) as Array<Record<string, unknown>>;
    if (seeds.length === 0) {
      return ok(c, { nodes: [], edges: [], seed_count: 0, truncated: false });
    }

    // Step 2 — every edge touching a seed, then the nodes on the far end.
    // D1 refuses more than 100 bound variables per statement (SQLITE_ERROR
    // "too many SQL variables"), so every IN (...) below runs in slices of
    // D1_BIND_CHUNK, and the edge query is one slice per side rather than
    // both sides in one statement.
    const ids = seeds.map((n) => String(n.id));
    const edgeSeen = new Set<string>();
    const edges: Array<Record<string, unknown>> = [];
    for (const side of ['src', 'dst'] as const) {
      for (let i = 0; i < ids.length; i += D1_BIND_CHUNK) {
        const slice = ids.slice(i, i + D1_BIND_CHUNK);
        const rows = await c.env.DB
          .prepare(
            `SELECT src, dst, kind, weight FROM kg_edges
             WHERE ${side} IN (${slice.map(() => '?').join(',')})`
          )
          .bind(...slice)
          .all();
        for (const e of (rows.results ?? []) as Array<Record<string, unknown>>) {
          const key = `${e.src}\u0000${e.dst}\u0000${e.kind}`;
          if (edgeSeen.has(key)) continue;
          edgeSeen.add(key);
          edges.push(e);
        }
      }
    }
    const need = new Set<string>(ids);
    for (const e of edges) { need.add(String(e.src)); need.add(String(e.dst)); }
    for (const id of ids) need.delete(id);

    let extra: Array<Record<string, unknown>> = [];
    if (need.size) {
      const list = [...need];
      for (let i = 0; i < list.length; i += D1_BIND_CHUNK) {
        const slice = list.slice(i, i + D1_BIND_CHUNK);
        const rows = await c.env.DB
          .prepare(
            `SELECT id, kind, label, seat_slug, family, trigger_line, dated_on, source_file
             FROM kg_nodes WHERE id IN (${slice.map(() => '?').join(',')})`
          )
          .bind(...slice)
          .all();
        extra = extra.concat((rows.results ?? []) as Array<Record<string, unknown>>);
      }
    }

    const present = new Set([...seeds, ...extra].map((n) => String(n.id)));
    return ok(c, {
      nodes: [...seeds.map((n) => ({ ...n, seed: true })), ...extra.map((n) => ({ ...n, seed: false }))],
      // An edge whose far end was never synced is dropped rather than drawn
      // into an empty circle.
      edges: edges.filter((e) => present.has(String(e.src)) && present.has(String(e.dst))),
      seed_count: seeds.length,
      truncated: seeds.length >= limit,
    });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/node/:id
// ---------------------------------------------------------------------------
knowledge.get('/node/:id{.+}', async (c) => {
  try {
    const id = decodeURIComponent(c.req.param('id'));
    const node = await c.env.DB
      .prepare(`SELECT * FROM kg_nodes WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!node) return fail(c, 404, [{ code: 'not_found', message: `no node ${id}` }]);

    const nb = await c.env.DB
      .prepare(
        `SELECT e.src, e.dst, e.kind, e.weight,
                n.label AS other_label, n.kind AS other_kind,
                n.trigger_line AS other_trigger, n.seat_slug AS other_seat
         FROM kg_edges e
         JOIN kg_nodes n ON n.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END
         WHERE e.src = ?1 OR e.dst = ?1
         ORDER BY e.kind, n.label`
      )
      .bind(id)
      .all();

    return ok(c, { node, neighbours: nb.results ?? [] });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/search
// ---------------------------------------------------------------------------
knowledge.get('/search', async (c) => {
  try {
    const q = c.req.query('q')?.trim();
    if (!q || q.length < 2) {
      return fail(c, 400, [{ code: 'q_too_short', message: 'q must be at least 2 characters' }]);
    }
    const limit = Math.min(Number(c.req.query('limit')) || 60, 200);
    const like = `%${q}%`;
    const rows = await c.env.DB
      .prepare(
        `SELECT id, kind, label, seat_slug, family, trigger_line, dated_on, source_file
         FROM kg_nodes
         WHERE trigger_line LIKE ?1 OR label LIKE ?1 OR body LIKE ?1
         ORDER BY
           -- a hit in the trigger line is the answer; a hit in the body is a lead
           CASE WHEN trigger_line LIKE ?1 THEN 0 ELSE 1 END,
           dated_on DESC NULLS LAST
         LIMIT ?2`
      )
      .bind(like, limit)
      .all();
    return ok(c, { results: rows.results ?? [], query: q });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// ---------------------------------------------------------------------------
// POST /api/knowledge/sync — one scope per call
// ---------------------------------------------------------------------------
knowledge.post('/sync', async (c) => {
  const token = bearer(c);
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'sign in first' }]);
  if (user.role !== 'admin') {
    return fail(c, 403, [{ code: 'forbidden', message: 'knowledge sync is admin-only' }]);
  }

  const scope = (c.req.query('scope') || '').trim();
  let sha = '';
  try {
    sha = await headSha(c.env);
    const tree = await orgTree(c.env, sha);
    const roster = rosterFromTree(tree);

    // No scope named → say what there is to do and let the caller drive the
    // loop. The server never fans out 22 scopes inside one request: that is the
    // shape that dies half way and reports a complete graph.
    if (!scope) {
      const done = await c.env.DB.prepare(`SELECT scope, ref_sha FROM kg_sync`).all();
      const current = new Map(
        ((done.results ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.scope), String(r.ref_sha)])
      );
      const all = ['law', ...roster.map((s) => `seat:${s}`)];
      const pending = all.filter((s) => current.get(s) !== sha);
      return ok(c, { ref_sha: sha, scopes: all, pending, next: pending[0] ?? null, done: all.length - pending.length });
    }

    const names = await rosterNames(c.env, tree);

    let built;
    let seatSlug: string | null = null;
    if (scope === 'law') {
      built = await buildLaw(c.env, tree);
    } else if (scope.startsWith('seat:')) {
      seatSlug = scope.slice(5);
      if (!roster.includes(seatSlug)) {
        return fail(c, 404, [{ code: 'unknown_seat', message: `${seatSlug} has no CHARTER.md in organizacia` }]);
      }
      built = await buildSeat(c.env, tree, seatSlug, names);
    } else {
      return fail(c, 400, [{ code: 'bad_scope', message: 'scope must be "law" or "seat:<slug>"' }]);
    }

    const result = await writeScope(c.env, scope, seatSlug, sha, built);

    const doneAfter = await c.env.DB.prepare(`SELECT scope, ref_sha FROM kg_sync`).all();
    const current = new Map(
      ((doneAfter.results ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.scope), String(r.ref_sha)])
    );
    const all = ['law', ...roster.map((s) => `seat:${s}`)];
    const pending = all.filter((s) => current.get(s) !== sha);

    return ok(c, { ...result, next: pending[0] ?? null, pending: pending.length, total: all.length });
  } catch (err) {
    if (err instanceof MissingTokenError) {
      return fail(c, 503, [{ code: 'org_token_missing', message: err.message }]);
    }
    if (scope && sha) await recordScopeError(c.env, scope, sha, err);
    return fail(c, 502, [fromError(err)]);
  }
});

export default knowledge;

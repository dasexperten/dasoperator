// =============================================================================
// Knowledge graph — ingestion.
//
// Reads the organizacia corpus from GitHub and writes the graph into D1.
//
// Two shapes worth naming before reading the code:
//
// 1. GitHub is the source of truth, D1 is a cache. Nothing here ever writes
//    back. A wrong row is fixed by re-syncing, never by editing D1 — the same
//    split the ERP already uses for R2-vs-D1.
//
// 2. Sync advances ONE SCOPE PER CALL (one seat, or the law file) and reports
//    `done / total`. A Worker request cannot parse 21 seats and several
//    thousand entries inside its CPU budget, and a sync that dies half way
//    through leaves a graph that looks complete and is not. Incremental with an
//    honest counter beats one call that silently truncates.
// =============================================================================
import type { Env } from '../types';
import {
  parseSeatFile,
  parseLawFile,
  parseRosterNames,
  citedLaws,
  citedRecords,
  topicsOf,
  mentionedSeats,
  type RosterName,
} from './kg-parse';

const ORG_REPO = 'dasexperten/organizacia';
const ORG_REF = 'main';
const GH = 'https://api.github.com';

/** D1 caps how many bound parameters one statement may carry. Stay well under. */
const BATCH = 40;

export interface SyncResult {
  scope: string;
  ref_sha: string;
  nodes: number;
  edges: number;
  note: string;
}

export class MissingTokenError extends Error {
  constructor() {
    super('ORG_SSOT_TOKEN is not bound on this Worker — organizacia is a private repo and cannot be read without it');
    this.name = 'MissingTokenError';
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function ghHeaders(env: Env): HeadersInit {
  const token = env.ORG_SSOT_TOKEN;
  if (!token) throw new MissingTokenError();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dasoperator-knowledge-graph',
  };
}

async function gh<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`${GH}${path}`, { headers: ghHeaders(env) });
  if (!res.ok) {
    const body = await res.text();
    // The first line only: a GitHub error page in a log is noise, and the code
    // plus the first line is what actually names the cause.
    throw new Error(`github ${res.status} on ${path}: ${(body.split('\n')[0] ?? '').slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

/** Head commit of organizacia@main — the sha every row is stamped with. */
export async function headSha(env: Env): Promise<string> {
  const c = await gh<{ sha: string }>(env, `/repos/${ORG_REPO}/commits/${ORG_REF}`);
  return c.sha;
}

interface TreeEntry { path: string; type: string; sha: string; size?: number }

export async function orgTree(env: Env, sha: string): Promise<TreeEntry[]> {
  const t = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
    env,
    `/repos/${ORG_REPO}/git/trees/${sha}?recursive=1`
  );
  if (t.truncated) {
    // Reporting a partial tree as the roster would drop seats without a word.
    throw new Error('github returned a truncated tree — the roster cannot be read whole from it');
  }
  return t.tree;
}

export async function blobText(env: Env, sha: string): Promise<string> {
  const b = await gh<{ content: string; encoding: string }>(env, `/repos/${ORG_REPO}/git/blobs/${sha}`);
  if (b.encoding !== 'base64') throw new Error(`unexpected blob encoding ${b.encoding}`);
  const bin = atob(b.content.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The roster, opened live from the files, exactly as HARD_RULES §0g requires.
 * `agents/new` is the onboarding template, not a seat — it never enters.
 */
export function rosterFromTree(tree: TreeEntry[]): string[] {
  return tree
    .filter((e) => e.type === 'blob' && /^agents\/[^/]+\/CHARTER\.md$/.test(e.path))
    .map((e) => e.path.split('/')[1] ?? '')
    .filter((slug) => slug !== '' && slug !== 'new')
    .sort();
}

/**
 * Seat names, read from the org's own registry (`api/roster-names.mjs`) rather
 * than from a copy kept here. Two lists of the same names drift silently, and
 * the drift shows up as a seat that answers in chat but is missing from every
 * graph. Registry absent → empty list, and the sync note says so.
 */
export async function rosterNames(env: Env, tree: TreeEntry[]): Promise<RosterName[]> {
  const entry = tree.find((e) => e.path === 'api/roster-names.mjs');
  if (!entry) return [];
  return parseRosterNames(await blobText(env, entry.sha));
}

// ---------------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------------

interface NodeRow {
  id: string; kind: string; label: string;
  seat_slug: string | null; family: string | null; trigger_line: string | null;
  body: string | null; dated_on: string | null;
  source_path: string | null; source_file: string | null;
}
interface EdgeRow { src: string; dst: string; kind: string; weight: number }

const seatId = (slug: string) => `seat:${slug}`;
const lawId = (section: string) => `law:${section}`;
const topicId = (id: string) => `topic:${id}`;
const recordId = (slug: string, address: string) => `record:${slug}/${address}`;

/**
 * Build one seat's slice of the graph: the seat itself, every entry in its
 * LEARNING/MEMORY, and the edges those entries carry.
 *
 * Law and topic nodes are written here as stubs when they are new — a topic
 * exists only because an entry is about it, and a law node created by a
 * citation is upgraded with its real title when the law scope syncs. An edge
 * to a node that does not exist would draw an empty circle on the page.
 */
export async function buildSeat(
  env: Env,
  tree: TreeEntry[],
  slug: string,
  roster: RosterName[]
): Promise<{ nodes: NodeRow[]; edges: EdgeRow[]; note: string }> {
  const nodes = new Map<string, NodeRow>();
  const edges = new Map<string, EdgeRow>();
  const name = roster.find((r) => r.slug === slug) ?? null;

  const addEdge = (src: string, dst: string, kind: string) => {
    const key = `${src}|${dst}|${kind}`;
    const prev = edges.get(key);
    if (prev) prev.weight += 1;
    else edges.set(key, { src, dst, kind, weight: 1 });
  };

  nodes.set(seatId(slug), {
    id: seatId(slug),
    kind: 'seat',
    label: name?.ru || name?.en || slug,
    seat_slug: slug,
    family: null,
    trigger_line: name?.role ?? null,
    body: null,
    dated_on: null,
    source_path: `agents/${slug}/CHARTER.md`,
    source_file: 'CHARTER',
  });

  let entries = 0;
  let noTrigger = 0;

  for (const file of ['LEARNING', 'MEMORY'] as const) {
    const path = `agents/${slug}/${file}.md`;
    const entry = tree.find((e) => e.path === path);
    if (!entry) continue;
    const text = await blobText(env, entry.sha);

    for (const rec of parseSeatFile(text)) {
      const id = recordId(slug, rec.address);
      if (!rec.triggerLine) noTrigger += 1;
      entries += 1;
      nodes.set(id, {
        id,
        kind: 'record',
        label: rec.address,
        seat_slug: slug,
        family: rec.family,
        trigger_line: rec.triggerLine,
        body: rec.body,
        dated_on: rec.dated_on,
        source_path: path,
        source_file: file,
      });
      addEdge(seatId(slug), id, 'authored');

      const haystack = `${rec.heading}\n${rec.body}`;

      for (const section of citedLaws(haystack)) {
        const lid = lawId(section);
        if (!nodes.has(lid)) {
          nodes.set(lid, {
            id: lid, kind: 'law', label: `§${section}`, seat_slug: null, family: null,
            trigger_line: null, body: null, dated_on: null,
            source_path: 'HARD_RULES.md', source_file: 'HARD_RULES',
          });
        }
        addEdge(id, lid, 'cites');
      }

      for (const other of citedRecords(rec.body)) {
        // Same-seat citation only. A cross-seat address cannot be resolved to a
        // seat from the text alone, and guessing whose entry it is would put an
        // invented author on the page.
        const oid = recordId(slug, other);
        addEdge(id, oid, 'refers');
      }

      for (const topic of topicsOf(rec.triggerLine)) {
        const tid = topicId(topic.id);
        if (!nodes.has(tid)) {
          nodes.set(tid, {
            id: tid, kind: 'topic', label: topic.label, seat_slug: null, family: null,
            trigger_line: null, body: null, dated_on: null, source_path: null, source_file: null,
          });
        }
        addEdge(id, tid, 'about');
      }

      for (const other of mentionedSeats(haystack, roster, slug)) {
        addEdge(id, seatId(other), 'mentions');
      }
    }
  }

  // `refers` edges may point at an address this seat does not actually hold —
  // an entry can cite a law-shaped id that was renumbered or lives elsewhere.
  // Drop those rather than draw an edge into nothing.
  const present = new Set(nodes.keys());
  for (const [key, e] of edges) {
    if (e.kind === 'refers' && !present.has(e.dst)) edges.delete(key);
  }

  const noteParts = [`${entries} entries`];
  if (noTrigger) noteParts.push(`${noTrigger} without a trigger line`);
  if (!name) noteParts.push('not in api/roster-names.mjs — no Cyrillic form, mentions of this seat are matched on latin only');

  return { nodes: [...nodes.values()], edges: [...edges.values()], note: noteParts.join(' · ') };
}

/** The law file: one node per cited section, plus the §-to-§ cross references. */
export async function buildLaw(
  env: Env,
  tree: TreeEntry[]
): Promise<{ nodes: NodeRow[]; edges: EdgeRow[]; note: string }> {
  const entry = tree.find((e) => e.path === 'HARD_RULES.md');
  if (!entry) throw new Error('HARD_RULES.md is not in the tree');
  const text = await blobText(env, entry.sha);
  const sections = parseLawFile(text);

  const nodes: NodeRow[] = sections.map((s) => ({
    id: lawId(s.section),
    kind: 'law',
    label: `§${s.section}`,
    seat_slug: null,
    family: null,
    trigger_line: s.title,
    body: s.body,
    dated_on: null,
    source_path: 'HARD_RULES.md',
    source_file: 'HARD_RULES',
  }));

  const known = new Set(sections.map((s) => s.section));
  const edges: EdgeRow[] = [];
  for (const s of sections) {
    for (const cited of citedLaws(s.body)) {
      if (cited === s.section || !known.has(cited)) continue;
      edges.push({ src: lawId(s.section), dst: lawId(cited), kind: 'cites', weight: 1 });
    }
  }

  return { nodes, edges, note: `${sections.length} sections` };
}

// ---------------------------------------------------------------------------
// D1 write — replace one scope wholesale
// ---------------------------------------------------------------------------

async function chunked(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH) {
    await db.batch(stmts.slice(i, i + BATCH));
  }
}

export async function writeScope(
  env: Env,
  scope: string,
  seatSlug: string | null,
  refSha: string,
  built: { nodes: NodeRow[]; edges: EdgeRow[]; note: string }
): Promise<SyncResult> {
  const db = env.DB;

  // Clear this scope first. A seat's own nodes are keyed by its slug; the law
  // and topic stubs it created are shared and are left alone — another seat may
  // be the only remaining citer, and deleting them would erase its edges too.
  if (seatSlug) {
    await db.batch([
      db.prepare(`DELETE FROM kg_edges WHERE seat_slug = ?`).bind(seatSlug),
      db.prepare(`DELETE FROM kg_nodes WHERE seat_slug = ? AND kind IN ('seat','record')`).bind(seatSlug),
    ]);
  } else {
    await db.batch([
      db.prepare(`DELETE FROM kg_edges WHERE seat_slug IS NULL`),
      db.prepare(`DELETE FROM kg_nodes WHERE kind = 'law' AND body IS NOT NULL`),
    ]);
  }

  const nodeStmts = built.nodes.map((n) =>
    db
      .prepare(
        `INSERT INTO kg_nodes
           (id, kind, label, seat_slug, family, trigger_line, body, dated_on, source_path, source_file, ref_sha, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,unixepoch())
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, label=excluded.label, seat_slug=excluded.seat_slug,
           family=excluded.family, trigger_line=excluded.trigger_line,
           -- A stub carries no body. Never let it overwrite a real one.
           body=COALESCE(excluded.body, kg_nodes.body),
           dated_on=excluded.dated_on, source_path=excluded.source_path,
           source_file=excluded.source_file, ref_sha=excluded.ref_sha,
           updated_at=unixepoch()`
      )
      .bind(
        n.id, n.kind, n.label, n.seat_slug, n.family, n.trigger_line,
        n.body, n.dated_on, n.source_path, n.source_file, refSha
      )
  );

  const edgeStmts = built.edges.map((e) =>
    db
      .prepare(
        `INSERT INTO kg_edges (src, dst, kind, weight, seat_slug, ref_sha, updated_at)
         VALUES (?,?,?,?,?,?,unixepoch())
         ON CONFLICT(src, dst, kind) DO UPDATE SET
           weight=excluded.weight, seat_slug=excluded.seat_slug,
           ref_sha=excluded.ref_sha, updated_at=unixepoch()`
      )
      .bind(e.src, e.dst, e.kind, e.weight, seatSlug, refSha)
  );

  await chunked(db, nodeStmts);
  await chunked(db, edgeStmts);

  await db
    .prepare(
      `INSERT INTO kg_sync (scope, ref_sha, nodes, edges, status, note, synced_at)
       VALUES (?,?,?,?,'ok',?,unixepoch())
       ON CONFLICT(scope) DO UPDATE SET
         ref_sha=excluded.ref_sha, nodes=excluded.nodes, edges=excluded.edges,
         status='ok', note=excluded.note, synced_at=unixepoch()`
    )
    .bind(scope, refSha, built.nodes.length, built.edges.length, built.note)
    .run();

  return { scope, ref_sha: refSha, nodes: built.nodes.length, edges: built.edges.length, note: built.note };
}

export async function recordScopeError(env: Env, scope: string, refSha: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await env.DB.prepare(
    `INSERT INTO kg_sync (scope, ref_sha, nodes, edges, status, note, synced_at)
     VALUES (?,?,0,0,'error',?,unixepoch())
     ON CONFLICT(scope) DO UPDATE SET
       ref_sha=excluded.ref_sha, status='error', note=excluded.note, synced_at=unixepoch()`
  )
    .bind(scope, refSha, msg.slice(0, 500))
    .run();
}

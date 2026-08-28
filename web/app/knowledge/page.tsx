'use client';

// =============================================================================
// Knowledge — the operator's view of what the organisation actually knows.
//
// The corpus is the craft and memory of every seat, plus the law they cite:
// GitHub dasexperten/organizacia. This page reads the ERP's cache of it and
// never claims to be live — the header always carries the commit and the hour
// the cache was built (HARD_RULES §9c: whatever is newest is what reaches the
// Owner, and a source that cannot say when it is from ranks below one that can).
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Network, RefreshCw, Search, ExternalLink, Copy } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api';
import { getUser } from '@/lib/auth';
import GraphCanvas, { type GraphNode, type GraphEdge } from '@/components/knowledge/graph-canvas';
import MdLite from '@/components/knowledge/md-lite';
import { findSimilar, groupSimilar, type CorpusItem, type SimilarGroup } from '@/components/knowledge/similar';

const ORG_BLOB = 'https://github.com/dasexperten/organizacia/blob/main';

interface ScopeRow {
  scope: string; ref_sha: string; nodes: number; edges: number;
  status: string; note: string | null; synced_at: number;
}
interface Stats {
  nodes_by_kind: Array<{ kind: string; n: number }>;
  records_by_family: Array<{ family: string; n: number }>;
  edges: number;
  scopes: ScopeRow[];
  synced_newest: number | null;
  synced_oldest: number | null;
  token_bound: boolean;
}
interface NodeDetail {
  node: GraphNode & { body?: string | null; source_path?: string | null; ref_sha?: string };
  neighbours: Array<{
    src: string; dst: string; kind: string; weight: number;
    other_label: string; other_kind: string; other_trigger: string | null; other_seat: string | null;
  }>;
}

/** Yerevan — the only clock the Owner is shown (HARD_RULES §9b.1e). */
function yerevan(unixSeconds: number | null): string {
  if (!unixSeconds) return 'never';
  return new Date(unixSeconds * 1000).toLocaleString('ru-RU', {
    timeZone: 'Asia/Yerevan', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function KnowledgePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [seedCount, setSeedCount] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const [seat, setSeat] = useState('');
  const [family, setFamily] = useState('');
  const [q, setQ] = useState('');
  const [queryTerm, setQueryTerm] = useState('');

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncLine, setSyncLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // near-duplicate finder
  const [threshold, setThreshold] = useState(0.8);
  const [similar, setSimilar] = useState<{ groups: SimilarGroup[]; items: Map<string, CorpusItem>; scanned: number } | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);

  const isAdmin = useMemo(() => getUser()?.role === 'admin', []);

  const seats = useMemo(() => {
    const list = (stats?.scopes ?? [])
      .filter((s) => s.scope.startsWith('seat:'))
      .map((s) => s.scope.slice(5));
    return list.sort();
  }, [stats]);

  const loadStats = useCallback(async () => {
    const res = await apiGet<Stats>('/api/knowledge/stats');
    if (res.success && res.result) setStats(res.result);
    else setError(res.errors[0]?.message ?? 'could not read the cache');
  }, []);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (seat) params.set('seat', seat);
    if (family) params.set('kind', family);
    if (queryTerm) params.set('q', queryTerm);
    params.set('limit', '400');
    const res = await apiGet<{ nodes: GraphNode[]; edges: GraphEdge[]; seed_count: number; truncated: boolean }>(
      `/api/knowledge/graph?${params.toString()}`
    );
    if (res.success && res.result) {
      setNodes(res.result.nodes);
      setEdges(res.result.edges);
      setSeedCount(res.result.seed_count);
      setTruncated(res.result.truncated);
    } else {
      setError(res.errors[0]?.message ?? 'could not build the graph');
      setNodes([]); setEdges([]); setSeedCount(0);
    }
    setLoading(false);
  }, [seat, family, queryTerm]);

  const runSimilar = useCallback(async () => {
    setSimilarBusy(true); setError(null); setSelected(null);
    const params = new URLSearchParams();
    if (seat) params.set('seat', seat);
    if (family) params.set('kind', family);
    const res = await apiGet<{ items: CorpusItem[] }>(`/api/knowledge/corpus?${params.toString()}`);
    if (!res.success || !res.result) {
      setError(res.errors[0]?.message ?? 'could not read the corpus'); setSimilarBusy(false); return;
    }
    const items = res.result.items;
    const pairs = findSimilar(items, threshold);
    const groups = groupSimilar(items, pairs);
    const byId = new Map(items.map((it) => [it.id, it]));
    // Draw the groups: their entries, their seats, and the similarity edges.
    const member = new Set<string>(); groups.forEach((g) => g.ids.forEach((id) => member.add(id)));
    const seatIds = new Set<string>();
    const gnodes: GraphNode[] = [];
    member.forEach((id) => {
      const it = byId.get(id); if (!it) return;
      gnodes.push({ id, kind: 'record', label: it.label, seat_slug: it.seat_slug, family: it.family, trigger_line: it.trigger_line, seed: true });
      if (it.seat_slug) seatIds.add(it.seat_slug);
    });
    seatIds.forEach((s) => gnodes.push({ id: `seat:${s}`, kind: 'seat', label: s, seat_slug: s }));
    const gedges: GraphEdge[] = pairs.map((pr) => ({ src: pr.a, dst: pr.b, kind: pr.cross ? 'similar_x' : 'similar', weight: pr.score }));
    member.forEach((id) => { const it = byId.get(id); if (it?.seat_slug) gedges.push({ src: `seat:${it.seat_slug}`, dst: id, kind: 'authored', weight: 1 }); });
    setNodes(gnodes); setEdges(gedges); setSeedCount(member.size); setTruncated(false);
    setSimilar({ groups, items: byId, scanned: items.length });
    setSimilarBusy(false);
  }, [seat, family, threshold]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { setSimilar(null); loadGraph(); }, [loadGraph]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let live = true;
    apiGet<NodeDetail>(`/api/knowledge/node/${encodeURIComponent(selected)}`).then((res) => {
      if (!live) return;
      setDetail(res.success && res.result ? res.result : null);
    });
    return () => { live = false; };
  }, [selected]);

  /**
   * Sync walks one scope per call and shows the counter as it goes. The server
   * refuses to fan out inside one request; the loop belongs here where a person
   * can watch it and stop it.
   */
  async function runSync() {
    setSyncing(true);
    setSyncLine('reading organizacia…');
    try {
      const plan = await apiPost<{ pending: string[]; next: string | null; scopes: string[] }>(
        '/api/knowledge/sync', {}
      );
      if (!plan.success || !plan.result) {
        setSyncLine(plan.errors[0]?.message ?? 'sync could not start');
        return;
      }
      const total = plan.result.scopes.length;
      let next: string | null = plan.result.next;
      let done = total - plan.result.pending.length;

      // The server hands back the next scope each time. Following its `next`
      // rather than a list built here means the loop cannot drift from what the
      // cache actually still needs.
      while (next) {
        setSyncLine(`${next} — ${done} of ${total}`);
        const res = await apiPost<{ next: string | null; nodes: number; edges: number }>(
          `/api/knowledge/sync?scope=${encodeURIComponent(next)}`, {}
        );
        if (!res.success || !res.result) {
          setSyncLine(`stopped on ${next} — ${res.errors[0]?.message ?? 'unknown error'}`);
          await loadStats();
          return;
        }
        done += 1;
        next = res.result.next;
      }
      setSyncLine(`done — ${done} of ${total} scopes`);
      await loadStats();
      await loadGraph();
    } finally {
      setSyncing(false);
    }
  }

  const kindCount = (kind: string) => stats?.nodes_by_kind.find((k) => k.kind === kind)?.n ?? 0;
  const staleSpread =
    stats?.synced_newest && stats?.synced_oldest ? stats.synced_newest - stats.synced_oldest : 0;

  return (
    <div className="dx-prose" style={{ maxWidth: 'none' }}>
      {/* ---------------------------------------------------------------- */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="dx-h1 flex items-center gap-3" style={{ marginBottom: 4 }}>
            <Network className="h-8 w-8" style={{ color: 'var(--brand-rot)' }} />
            Knowledge
          </h1>
          <p style={{ color: 'var(--fg-3)', margin: 0 }}>
            Every seat&apos;s craft and memory, and the law it cites — read from organizacia,
            cached here.
          </p>
        </div>

        {isAdmin && (
          <button
            type="button"
            onClick={runSync}
            disabled={syncing}
            className="flex items-center gap-2"
            style={{
              background: syncing ? 'var(--stone-300)' : 'var(--brand-schwarz)',
              color: 'var(--paper)', border: 'none', borderRadius: 'var(--radius-sm)',
              padding: '10px 16px', fontWeight: 700, fontSize: 15,
              cursor: syncing ? 'default' : 'pointer',
            }}
          >
            <RefreshCw className="h-4 w-4" />
            {syncing ? 'Syncing…' : 'Sync from GitHub'}
          </button>
        )}
      </div>

      {/* Freshness. Two dates, because one hides a half-stale cache. */}
      <div
        className="flex items-center gap-4 flex-wrap"
        style={{
          marginTop: 16, padding: '10px 14px', background: 'var(--bg-sunk)',
          borderRadius: 'var(--radius-sm)', fontSize: 14, color: 'var(--fg-2)',
        }}
      >
        <span><strong>{kindCount('record')}</strong> entries</span>
        <span><strong>{kindCount('seat')}</strong> seats</span>
        <span><strong>{kindCount('law')}</strong> law sections</span>
        <span><strong>{kindCount('topic')}</strong> topics</span>
        <span><strong>{stats?.edges ?? 0}</strong> links</span>
        <span style={{ color: 'var(--fg-3)' }}>
          built {yerevan(stats?.synced_newest ?? null)}
          {staleSpread > 86400 && (
            <em style={{ color: 'var(--status-warning)', fontStyle: 'normal', fontWeight: 700 }}>
              {' '}· oldest scope {yerevan(stats?.synced_oldest ?? null)}
            </em>
          )}
        </span>
        {stats && !stats.token_bound && (
          <span style={{ color: 'var(--status-error)', fontWeight: 700 }}>
            no GitHub read token bound — sync cannot run
          </span>
        )}
      </div>

      {syncLine && (
        <div style={{ marginTop: 10, fontSize: 14, color: 'var(--fg-2)' }}>{syncLine}</div>
      )}
      {error && (
        <div style={{ marginTop: 10, fontSize: 14, color: 'var(--status-error)', fontWeight: 700 }}>{error}</div>
      )}

      {/* ---------------------------------------------------------------- */}
      <div className="flex items-end gap-3 flex-wrap" style={{ marginTop: 20 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--fg-3)' }}>
          Seat
          <select
            value={seat}
            onChange={(e) => { setSeat(e.target.value); setSelected(null); }}
            style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontSize: 15, minWidth: 200 }}
          >
            <option value="">All seats</option>
            {seats.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--fg-3)' }}>
          Family
          <select
            value={family}
            onChange={(e) => { setFamily(e.target.value); setSelected(null); }}
            style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontSize: 15, minWidth: 160 }}
          >
            <option value="">All families</option>
            {(stats?.records_by_family ?? []).map((f) => (
              <option key={f.family} value={f.family}>{f.family} ({f.n})</option>
            ))}
          </select>
        </label>

        <form
          onSubmit={(e) => { e.preventDefault(); setQueryTerm(q.trim()); setSelected(null); }}
          style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--fg-3)' }}>
            Search trigger lines and bodies
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="hreflang · выкат · 404 · landed-cost"
              style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontSize: 15, minWidth: 280 }}
            />
          </label>
          <button
            type="submit"
            style={{
              background: 'var(--brand-rot)', color: 'var(--paper)', border: 'none',
              borderRadius: 'var(--radius-sm)', padding: '9px 14px', cursor: 'pointer',
            }}
            aria-label="Search"
          >
            <Search className="h-4 w-4" />
          </button>
        </form>

        {(seat || family || queryTerm) && (
          <button
            type="button"
            onClick={() => { setSeat(''); setFamily(''); setQ(''); setQueryTerm(''); setSelected(null); }}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-link)', cursor: 'pointer', fontSize: 14, paddingBottom: 10 }}
          >
            Clear
          </button>
        )}

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--fg-3)' }}>
            Similar from {Math.round(threshold * 100)}%
            <input
              type="range" min={60} max={95} step={5} value={Math.round(threshold * 100)}
              onChange={(e) => setThreshold(Number(e.target.value) / 100)}
              style={{ width: 120 }}
              aria-label="Similarity threshold"
            />
          </label>
          <button
            type="button"
            onClick={runSimilar}
            disabled={similarBusy}
            style={{
              background: 'var(--brand-schwarz)', color: 'var(--paper)', border: 'none',
              borderRadius: 'var(--radius-sm)', padding: '9px 14px', cursor: 'pointer', fontSize: 15, fontWeight: 700,
              display: 'flex', alignItems: 'center', gap: 6, opacity: similarBusy ? 0.6 : 1,
            }}
          >
            <Copy className="h-4 w-4" /> {similarBusy ? 'comparing…' : 'Find similar'}
          </button>
        </div>

        <span style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--fg-3)', paddingBottom: 10 }}>
          {loading ? 'loading…' : similar ? `${similar.groups.length} groups · ${seedCount} entries of ${similar.scanned}` : `${seedCount} entries match`}
          {truncated && (
            <em style={{ color: 'var(--status-warning)', fontStyle: 'normal', fontWeight: 700 }}> · capped at 400</em>
          )}
        </span>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 20, marginTop: 16 }} className="dx-kg-grid">
        <GraphCanvas nodes={nodes} edges={edges} selectedId={selected} onSelect={setSelected} />

        <aside
          style={{
            background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-card)', padding: 18, maxHeight: 'min(72vh, 720px)', overflow: 'auto',
          }}
        >
          {!detail && similar && (
            <div>
              <div style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 6 }}>
                NEAR-DUPLICATES · {Math.round(threshold * 100)}% · {similar.scanned} entries scanned
              </div>
              {similar.groups.length === 0 && (
                <p style={{ color: 'var(--fg-3)', fontSize: 15 }}>No two entries under this filter repeat each other at this threshold.</p>
              )}
              {similar.groups.map((g, gi) => (
                <div key={gi} style={{ borderTop: '1px solid var(--border-hairline)', padding: '10px 0' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                    <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--fg-1)' }}>{g.ids.length} entries</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: g.cross ? 'var(--line-innoweiss)' : 'var(--status-warning)' }}>
                      {g.cross ? `across ${g.seats.length} seats — one law, many copies` : `${g.seats[0]} — seam should fold these`}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--fg-3)' }}>{Math.round(g.score * 100)}%</span>
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--fg-1)', marginBottom: 6 }}>
                    {similar.items.get(g.ids[0] ?? '')?.trigger_line}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {g.ids.map((id) => (
                      <button
                        key={id} type="button" onClick={() => setSelected(id)}
                        style={{ fontSize: 12, fontWeight: 700, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
                          background: 'var(--bg-muted, var(--stone-100))', border: '1px solid var(--border-subtle)', color: 'var(--fg-1)' }}
                        title={id}
                      >
                        {similar.items.get(id)?.label ?? id.replace(/^record:[^/]+\//, '')}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!detail && !similar && (
            <p style={{ color: 'var(--fg-3)', fontSize: 15 }}>
              Click a node. A seat shows what it wrote; an entry shows its condition, its body and
              what it cites; a law section shows who cites it.
            </p>
          )}

          {detail && (
            <>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 0 }}>
                {detail.node.kind}
                {detail.node.family ? ` · ${detail.node.family}` : ''}
                {detail.node.dated_on ? ` · ${detail.node.dated_on}` : ''}
              </div>
              <h2 className="dx-h3" style={{ marginTop: 4, marginBottom: 8 }}>{detail.node.label}</h2>

              {detail.node.trigger_line && (
                <p style={{
                  background: 'var(--bg-sunk)', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                  fontSize: 15, fontWeight: 600, margin: '0 0 12px',
                }}>
                  {detail.node.trigger_line}
                </p>
              )}

              {detail.node.source_path && (
                <a
                  href={`${ORG_BLOB}/${detail.node.source_path}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1"
                  style={{ color: 'var(--fg-link)', fontSize: 13, marginBottom: 12 }}
                >
                  {detail.node.source_path} <ExternalLink className="h-3 w-3" />
                </a>
              )}

              {detail.node.body && <MdLite text={detail.node.body} />}

              {detail.neighbours.length > 0 && (
                <>
                  <div style={{ height: 1, background: 'var(--border-hairline)', margin: '4px 0 12px' }} />
                  <div style={{ fontSize: 12, color: 'var(--fg-3)', marginBottom: 8 }}>
                    {detail.neighbours.length} links
                  </div>
                  {detail.neighbours.map((nb, i) => {
                    const otherId = nb.src === detail.node.id ? nb.dst : nb.src;
                    const outgoing = nb.src === detail.node.id;
                    return (
                      <button
                        key={`${otherId}-${nb.kind}-${i}`}
                        type="button"
                        onClick={() => setSelected(otherId)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                          border: 'none', borderBottom: '1px solid var(--border-hairline)',
                          padding: '8px 0', cursor: 'pointer',
                        }}
                      >
                        <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                          {outgoing ? '→' : '←'} {nb.kind}
                        </span>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--fg-1)' }}>
                          {nb.other_label}
                        </span>
                        {nb.other_trigger && (
                          <span style={{ display: 'block', fontSize: 13, color: 'var(--fg-2)' }}>
                            {nb.other_trigger}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </aside>
      </div>

    </div>
  );
}

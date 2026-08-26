'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

// =============================================================================
// GraphCanvas — the knowledge graph, drawn as plain SVG.
//
// No graph library on purpose: the whole layout is ~120 lines, and a dependency
// here would have to be carried through the edge runtime for the rest of the
// app's life.
//
// The layout is DETERMINISTIC. Same nodes in, same picture out — no Math.random
// anywhere. A graph that reshuffles itself on every refresh cannot be pointed at
// in a conversation, and pointing at it is most of what it is for.
// =============================================================================

export interface GraphNode {
  id: string;
  kind: 'seat' | 'record' | 'law' | 'topic';
  label: string;
  seat_slug?: string | null;
  family?: string | null;
  trigger_line?: string | null;
  dated_on?: string | null;
  source_file?: string | null;
  seed?: boolean;
}

export interface GraphEdge {
  src: string;
  dst: string;
  kind: 'authored' | 'cites' | 'refers' | 'mentions' | 'about';
  weight?: number;
}

/** How many nodes the simulation will lay out before it starts leaving some out. */
const MAX_SIM = 500;
const ITERATIONS = 90;
const W = 1000;
const H = 720;

const FAMILY_COLOR: Record<string, string> = {
  LAW:   'var(--line-innoweiss)',
  HARD:  'var(--brand-rot)',
  RULE:  'var(--line-fresh)',
  CRAFT: 'var(--line-sensitive)',
  MEM:   'var(--stone-400)',
  LOG:   'var(--stone-300)',
  FM:    'var(--line-kids)',
};

const EDGE_STYLE: Record<GraphEdge['kind'], { stroke: string; opacity: number; dash?: string }> = {
  authored: { stroke: 'var(--stone-300)', opacity: 0.35 },
  cites:    { stroke: 'var(--brand-rot)', opacity: 0.45 },
  refers:   { stroke: 'var(--line-innoweiss)', opacity: 0.4, dash: '3 3' },
  mentions: { stroke: 'var(--stone-400)', opacity: 0.28, dash: '2 4' },
  about:    { stroke: 'var(--brand-gold)', opacity: 0.5 },
};

function nodeColor(n: GraphNode): string {
  if (n.kind === 'seat') return 'var(--brand-schwarz)';
  if (n.kind === 'law') return 'var(--brand-rot)';
  if (n.kind === 'topic') return 'var(--brand-gold)';
  return FAMILY_COLOR[n.family ?? ''] ?? 'var(--stone-400)';
}

function nodeRadius(n: GraphNode, degree: number): number {
  if (n.kind === 'seat') return 16;
  if (n.kind === 'law') return 9 + Math.min(degree, 12) * 0.5;
  if (n.kind === 'topic') return 5 + Math.min(degree, 16) * 0.45;
  return 5.5;
}

interface Placed extends GraphNode { x: number; y: number; degree: number; r: number }

/**
 * Spring layout with a fixed schedule. Seeded by index on a circle rather than
 * at random, so the result is reproducible run to run.
 */
function layout(nodes: GraphNode[], edges: GraphEdge[]): { placed: Placed[]; dropped: number } {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }

  // Seats and seeds first, then whatever else is best connected. When the graph
  // is bigger than the simulation budget, the parts that carry the most edges
  // are the parts worth drawing.
  const ordered = [...nodes].sort((a, b) => {
    const rank = (n: GraphNode) => (n.kind === 'seat' ? 0 : n.seed ? 1 : 2);
    const dr = rank(a) - rank(b);
    if (dr !== 0) return dr;
    return (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
  });
  const kept = ordered.slice(0, MAX_SIM);
  const dropped = ordered.length - kept.length;

  const idx = new Map(kept.map((n, i) => [n.id, i]));
  const n = kept.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);

  // Deterministic seeding: kind decides the ring, index decides the angle.
  for (let i = 0; i < n; i++) {
    const node = kept[i];
    const ring = node.kind === 'seat' ? 90 : node.kind === 'law' ? 180 : node.kind === 'topic' ? 320 : 250;
    const angle = (2 * Math.PI * i) / n + (node.kind === 'topic' ? Math.PI / 7 : 0);
    xs[i] = W / 2 + Math.cos(angle) * ring;
    ys[i] = H / 2 + Math.sin(angle) * ring;
  }

  const links = edges
    .map((e) => [idx.get(e.src), idx.get(e.dst)] as [number | undefined, number | undefined])
    .filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined);

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  for (let it = 0; it < ITERATIONS; it++) {
    const cooling = 1 - it / ITERATIONS;
    fx.fill(0); fy.fill(0);

    // Repulsion, every pair. n is capped at MAX_SIM precisely so this stays
    // affordable on the main thread.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = xs[i] - xs[j];
        let dy = ys[i] - ys[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = ((i % 7) - 3) || 1; dy = ((j % 5) - 2) || 1; d2 = dx * dx + dy * dy; }
        const f = 2600 / d2;
        const dxf = dx * f, dyf = dy * f;
        fx[i] += dxf; fy[i] += dyf;
        fx[j] -= dxf; fy[j] -= dyf;
      }
    }

    // Springs
    for (const [a, b] of links) {
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 70) * 0.012;
      const dxf = (dx / d) * f * d;
      const dyf = (dy / d) * f * d;
      fx[a] += dxf; fy[a] += dyf;
      fx[b] -= dxf; fy[b] -= dyf;
    }

    // Gentle pull to centre so detached nodes do not sail off the viewport
    for (let i = 0; i < n; i++) {
      fx[i] += (W / 2 - xs[i]) * 0.012;
      fy[i] += (H / 2 - ys[i]) * 0.012;
      const step = 6 * cooling;
      const len = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i]) || 1;
      const cap = Math.min(len, 24);
      xs[i] += (fx[i] / len) * cap * step * 0.18;
      ys[i] += (fy[i] / len) * cap * step * 0.18;
    }
  }

  const placed: Placed[] = kept.map((node, i) => {
    const deg = degree.get(node.id) ?? 0;
    return { ...node, x: xs[i], y: ys[i], degree: deg, r: nodeRadius(node, deg) };
  });
  return { placed, dropped };
}

export default function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { placed, dropped } = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const pos = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const visibleEdges = useMemo(
    () => edges.filter((e) => pos.has(e.src) && pos.has(e.dst)),
    [edges, pos]
  );

  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Reset the pan/zoom whenever a new set of nodes arrives — keeping an old
  // offset over a different graph puts the reader somewhere off the picture.
  useEffect(() => { setView({ x: 0, y: 0, k: 1 }); }, [nodes]);

  const focus = hover ?? selectedId;
  const focusNeighbours = useMemo(() => {
    if (!focus) return null;
    const s = new Set<string>([focus]);
    for (const e of visibleEdges) {
      if (e.src === focus) s.add(e.dst);
      if (e.dst === focus) s.add(e.src);
    }
    return s;
  }, [focus, visibleEdges]);

  function onWheel(ev: React.WheelEvent) {
    ev.preventDefault();
    setView((v) => {
      const k = Math.min(4, Math.max(0.4, v.k * (ev.deltaY < 0 ? 1.12 : 0.89)));
      return { ...v, k };
    });
  }

  function onPointerDown(ev: React.PointerEvent) {
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    drag.current = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  }
  function onPointerMove(ev: React.PointerEvent) {
    if (!drag.current) return;
    const d = drag.current;
    setView((v) => ({ ...v, x: d.vx + (ev.clientX - d.x) / v.k, y: d.vy + (ev.clientY - d.y) / v.k }));
  }
  function onPointerUp() { drag.current = null; }

  if (placed.length === 0) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ height: 420, color: 'var(--fg-3)', background: 'var(--bg-sunk)', borderRadius: 'var(--radius-md)' }}
      >
        Nothing matches these filters.
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{
          width: '100%',
          height: 'min(72vh, 720px)',
          background: 'var(--bg-sunk)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-hairline)',
          touchAction: 'none',
          cursor: drag.current ? 'grabbing' : 'grab',
        }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${W / 2} ${H / 2}) scale(${view.k}) translate(${-W / 2 + view.x} ${-H / 2 + view.y})`}>
          {visibleEdges.map((e, i) => {
            const a = pos.get(e.src)!;
            const b = pos.get(e.dst)!;
            const style = EDGE_STYLE[e.kind] ?? EDGE_STYLE.refers;
            const dim = focusNeighbours && !(focusNeighbours.has(e.src) && focusNeighbours.has(e.dst));
            return (
              <line
                key={`${e.src}|${e.dst}|${e.kind}|${i}`}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={style.stroke}
                strokeOpacity={dim ? 0.06 : style.opacity}
                strokeWidth={e.kind === 'authored' ? 0.7 : 1}
                strokeDasharray={style.dash}
              />
            );
          })}

          {placed.map((n) => {
            const dim = focusNeighbours && !focusNeighbours.has(n.id);
            const isSelected = n.id === selectedId;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x} ${n.y})`}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelect(n.id)}
                style={{ cursor: 'pointer', opacity: dim ? 0.16 : 1 }}
              >
                <circle
                  r={n.r}
                  fill={nodeColor(n)}
                  fillOpacity={n.kind === 'topic' ? 0.22 : 0.9}
                  stroke={isSelected ? 'var(--brand-schwarz-ink)' : nodeColor(n)}
                  strokeWidth={isSelected ? 3 : n.kind === 'topic' ? 1.4 : 0}
                />
                {(n.kind === 'seat' || n.kind === 'law' || isSelected || n.r > 8) && (
                  <text
                    y={n.r + 12}
                    textAnchor="middle"
                    style={{
                      fontFamily: 'var(--font-body)',
                      fontSize: n.kind === 'seat' ? 13 : 11,
                      fontWeight: n.kind === 'seat' ? 800 : 600,
                      fill: 'var(--fg-2)',
                      letterSpacing: 0,
                      pointerEvents: 'none',
                    }}
                  >
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Never let the picture imply it is the whole graph. */}
      {dropped > 0 && (
        <div
          style={{
            position: 'absolute', left: 12, bottom: 12,
            background: 'var(--bg-surface)', color: 'var(--status-warning)',
            padding: '6px 10px', borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-card)', fontSize: 13, fontWeight: 700,
          }}
        >
          {dropped} more nodes match and are not drawn — narrow the filter to see them
        </div>
      )}

      <div
        style={{
          position: 'absolute', right: 12, top: 12,
          background: 'var(--bg-surface)', boxShadow: 'var(--shadow-card)',
          borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12,
        }}
      >
        {(['seat', 'law', 'topic'] as const).map((k) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: k === 'seat' ? 'var(--brand-schwarz)' : k === 'law' ? 'var(--brand-rot)' : 'var(--brand-gold)',
              display: 'inline-block',
            }} />
            <span style={{ color: 'var(--fg-2)' }}>{k}</span>
          </div>
        ))}
        <div style={{ height: 1, background: 'var(--border-hairline)', margin: '6px 0' }} />
        {Object.entries(FAMILY_COLOR).map(([fam, col]) => (
          <div key={fam} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: col, display: 'inline-block' }} />
            <span style={{ color: 'var(--fg-2)' }}>{fam}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

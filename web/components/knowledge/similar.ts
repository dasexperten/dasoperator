// =============================================================================
// similar — near-duplicate entries in the knowledge corpus.
//
// Two entries are "similar" when the word sets of their trigger line and the
// head of their body overlap by at least the threshold (Jaccard). No model:
// the ERP has no hands, and a repeated paragraph is a repeated paragraph in
// any language. Cyrillic words are cut to a five-letter stem, latin to six, so
// «остатков» and «остатки», "citation" and "citations" count as one word.
//
// Same-seat pairs are waste the weekly seam should fold into one entry.
// Cross-seat pairs are usually one law living in many copies — a candidate
// for HARD_RULES, where it would be one change instead of twenty-one.
// =============================================================================

export interface CorpusItem {
  id: string;
  seat_slug: string | null;
  family: string | null;
  label: string;
  trigger_line: string | null;
  body_head: string | null;
}

export interface SimilarPair { a: string; b: string; score: number; cross: boolean }
export interface SimilarGroup { ids: string[]; seats: string[]; cross: boolean; score: number }

const STOP = new Set([
  'если', 'это', 'как', 'что', 'для', 'при', 'или', 'без', 'над', 'под', 'его', 'её', 'их',
  'она', 'они', 'оно', 'все', 'всё', 'так', 'уже', 'ещё', 'еще', 'нет', 'да', 'не', 'ни',
  'the', 'and', 'for', 'not', 'with', 'from', 'that', 'this', 'are', 'was', 'you', 'your',
]);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.toLowerCase().replace(/[`*_#|>\[\]()"«»„“”.,:;!?—–\-\/\\]+/g, ' ').split(/\s+/);
  for (const w of words) {
    if (w.length < 3 || STOP.has(w)) continue;
    // an address in the body is a citation, not a word
    if (/^\d{6,8}$/.test(w) || /^[a-z]{2}\d*$/.test(w) && w.length < 4) continue;
    out.add(/[а-яё]/.test(w) ? w.slice(0, 5) : w.slice(0, 6));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  a.forEach((w) => { if (b.has(w)) inter++; });
  return inter / (a.size + b.size - inter);
}

/**
 * Pairs at or above the threshold. Candidates are blocked by shared rare
 * tokens (document frequency under 10 % of the corpus) so the pass stays
 * near-linear; a pair that shares no rare word cannot be 60 % similar anyway.
 */
export function findSimilar(items: CorpusItem[], threshold: number): SimilarPair[] {
  const docs = items.map((it) => tokens(`${it.trigger_line ?? ''}\n${it.body_head ?? ''}`));
  const df = new Map<string, number>();
  docs.forEach((d) => d.forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)));
  const maxDf = Math.max(3, Math.floor(items.length * 0.1));
  const index = new Map<string, number[]>();
  docs.forEach((d, i) => {
    d.forEach((w) => {
      if ((df.get(w) ?? 0) > maxDf) return;
      const list = index.get(w); if (list) list.push(i); else index.set(w, [i]);
    });
  });
  const seen = new Set<string>();
  const pairs: SimilarPair[] = [];
  docs.forEach((d, i) => {
    const cand = new Set<number>();
    d.forEach((w) => (index.get(w) ?? []).forEach((j) => { if (j > i) cand.add(j); }));
    cand.forEach((j) => {
      const key = `${i}|${j}`; if (seen.has(key)) return; seen.add(key);
      const s = jaccard(d, docs[j]!);
      if (s >= threshold) {
        const A = items[i]!, B = items[j]!;
        pairs.push({ a: A.id, b: B.id, score: s, cross: A.seat_slug !== B.seat_slug });
      }
    });
  });
  return pairs.sort((p, q) => q.score - p.score);
}

/** Union-find over the pairs → groups, largest first. */
export function groupSimilar(items: CorpusItem[], pairs: SimilarPair[]): SimilarGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const p of pairs) parent.set(find(p.a), find(p.b));
  const byRoot = new Map<string, string[]>();
  pairs.forEach((p) => [p.a, p.b].forEach((id) => {
    const r = find(id); const l = byRoot.get(r) ?? []; if (l.indexOf(id) === -1) l.push(id); byRoot.set(r, l);
  }));
  const seatOf = new Map(items.map((it) => [it.id, it.seat_slug ?? '']));
  const groups: SimilarGroup[] = [];
  byRoot.forEach((ids) => {
    const seats = ids.map((id) => seatOf.get(id) ?? '').filter((v, k, arr) => v && arr.indexOf(v) === k);
    const inGroup = pairs.filter((p) => ids.indexOf(p.a) !== -1 && ids.indexOf(p.b) !== -1);
    const score = inGroup.reduce((s, p) => s + p.score, 0) / Math.max(1, inGroup.length);
    groups.push({ ids: ids.sort(), seats, cross: seats.length > 1, score });
  });
  return groups.sort((a, b) => b.ids.length - a.ids.length || b.score - a.score);
}

// Diana's §9g profile for each Direct answer (Owner 2026-10-16: «прочитав каждый message,
// подгружалось: harness, voice, устав, hardrules… learning и crafts и те memories, которые
// нужны Диане для ответа»). Pure: parsing and selection only; fetching lives in the lane.
// Selection follows fleet/shared/compose-surface.mjs (organizacia): entries are matched by
// the trigger part of their heading, rare words weigh more, the top within 70 % of the best.

const STOP = new Set('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему для мы тебя их чем была сам без чего раз тоже себе под будет если или быть был до вас при это the and for that with this from'.split(' '));
const EN_STOP = new Set('the and for that with this from are was were has have not you your our'.split(' '));
const STEM = 4;
const FLOOR = 0.7;

export function toks(s) {
  const out = new Set();
  for (let w of String(s || '').toLowerCase().match(/[\wа-яё]{2,}/gi) || []) {
    if (/[а-яё]/.test(w)) {
      if (w.length < 4) continue;
      w = w.slice(0, STEM);
      if (STOP.has(w)) continue;
    } else if (/^\d+$/.test(w)) {
      if (w.length !== 3) continue;
    } else {
      if (/^(19|20)\d{2}/.test(w) || EN_STOP.has(w)) continue;
      w = w.slice(0, STEM);
    }
    out.add(w);
  }
  return out;
}

/** «## ID | trigger» sections outside code fences; «[регистр]» headings are not entries. */
export function parseEntries(text) {
  const out = [];
  let fence = false, cur = null;
  for (const line of String(text || '').split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) {
      if (cur) out.push(cur);
      cur = /\[регистр\]/.test(line) ? null : { heading: line.slice(3).trim(), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map((e) => ({ heading: e.heading, text: e.body.join('\n').trim() }));
}

const trigger = (h) => { const i = h.indexOf('|'); return i === -1 ? h : h.slice(i + 1); };

export function matchEntries(query, entries, top = 12) {
  const docs = entries.map((e) => toks(trigger(e.heading)));
  const df = {};
  for (const d of docs) for (const w of d) df[w] = (df[w] || 0) + 1;
  const n = docs.length || 1;
  const q = toks(query);
  const scored = [];
  for (let i = 0; i < entries.length; i++) {
    const common = [...q].filter((w) => docs[i].has(w));
    if (!common.length) continue;
    scored.push({ score: common.reduce((s, w) => s + Math.log(n / df[w]), 0), entry: entries[i] });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const best = scored[0].score;
  return scored.filter((x) => x.score >= best * FLOOR).slice(0, top).map((x) => x.entry);
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

/**
 * files: { harness, voice, charter, hardRules, learning, memory } (raw text).
 * query: what the blogger wrote (recent messages). Returns the system prompt.
 */
export function composeDiana(files, query) {
  const learning = matchEntries(query, parseEntries(files.learning), 12);
  const memory = matchEntries(query, parseEntries(files.memory), 4);
  const hard = matchEntries(query, parseEntries(files.hardRules), 3);
  const block = (title, entries, each) => entries.length
    ? `=== ${title} (подобрано под сообщение) ===\n${entries.map((e) => `## ${e.heading}\n${cut(e.text, each)}`).join('\n\n')}`
    : '';
  return [
    `=== 00 harness: DIRECT_RULES.md ===\n${files.harness || ''}`,
    `=== 01 VOICE.md (whole) ===\n${files.voice || ''}`,
    `=== 02 CHARTER.md (whole) ===\n${files.charter || ''}`,
    block('03 HARD_RULES.md', hard, 5000),
    block('04 LEARNING.md', learning, 3500),
    block('05 MEMORY.md', memory, 3000),
  ].filter(Boolean).join('\n\n');
}

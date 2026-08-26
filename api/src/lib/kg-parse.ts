// =============================================================================
// Knowledge graph — parsers. Pure functions, no network, no D1.
//
// They read the organizacia corpus in the shape HARD_RULES §9g defines it:
//
//   ## KIND-YYYYMMDD-NN | если X — делай Y      ← a craft/memory entry
//   ### KIND-YYYYMMDD-NN | …                    ← an entry inside a family box
//   #### Completed / Rollback / Verification    ← body structure, NOT an entry
//   ## [регистр] …                              ← a structural register, NOT an entry
//   ## 0b. Facts only — zero inventions         ← a law section in HARD_RULES.md
//
// Two rules that are easy to get wrong and expensive to get wrong:
//   * headings inside ``` fences are text, not headings (§9g «заголовки вне ограды»);
//   * a heading with no `KIND-DATE-NN` address may still be an entry — the legacy
//     form is a bare date (`## 2026-07-30 | условие`). It gets an address built
//     from that date so two of them on one day do not collide.
// =============================================================================

/**
 * A record address: `<FAMILY>-<YYYYMMDD>-<NN>`.
 *
 * The family is deliberately NOT a closed list. §9g names nine of them and then
 * says «или своя семья места, где она уже есть» — seats already carry EV, SR,
 * JW, L, M and §. A closed list silently demotes any entry whose family is not
 * on it: Mina's own `LEARN-20260819-01` parsed as familyless until this was
 * opened up, which is one entry lost from every family filter.
 */
const FAMILY_RE = /^([A-ZА-Я§]{1,8})-(\d{8})-(\d+)$/;

/**
 * A seat's own numbering, with no date in it: `EV-01` (Taras), `M1` (Tamara),
 * `JW-005` (Jurgen). §9g allows these outright — «или своя семья места, где она
 * уже есть … Свои номера по строю не перенумеровываются» — so they are entries
 * with a family and no date, not entries with no family. 78 of them across two
 * seats read as familyless until this was added.
 */
const OWN_NUMBER_RE = /^([A-ZА-Я§]{1,8})-?(\d{1,4})$/;

/** Legacy address: a bare date instead of an id. */
const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `§0b` · `§8.1` · `§0c-1` · `§9b.2c` — a citation of the law. */
const LAW_CITE_RE = /§\s*([0-9]+[a-z]*(?:[-.][0-9a-z]+)*)/gi;

/** A citation of another entry by its own address. */
const RECORD_CITE_RE = /\b(HARD|LAW|RULE|CRAFT|MEM|LOG|FM|CASE|PB|EV|SR|JW)-(\d{8})-(\d+)\b/g;

/**
 * A latin working term in a trigger line. §9d requires one: a Cyrillic-only
 * condition is blind to an English task line, so these tokens ARE the index
 * the selection runs on. Pure-digit codes (404, 301, 1042) count — they are
 * how the board names those topics.
 */
const TOPIC_RE = /\b(?:[A-Za-z][A-Za-z0-9]{1,}(?:[-.][A-Za-z0-9]+)*|\d{3,4})\b/g;

/** Words that are latin but carry no topic. Kept short on purpose. */
const TOPIC_STOP = new Set([
  'the', 'and', 'for', 'not', 'you', 'your', 'his', 'her', 'its', 'with', 'from',
  'that', 'this', 'has', 'have', 'was', 'were', 'are', 'but', 'all', 'any', 'one',
  'two', 'per', 'via', 'out', 'into', 'over', 'when', 'then', 'than', 'only',
  'md', 'com', 'ru', 'www', 'http', 'https',
]);

export interface KgRecord {
  /** `<slug>/<address>` — unique inside one seat's file set. */
  address: string;
  family: string | null;
  dated_on: string | null;
  heading: string;
  triggerLine: string | null;
  body: string;
  /** `## ` → 2, `### ` → 3. */
  level: number;
}

export interface KgLawSection {
  /** `0b` · `9g` · `8.1` — the number the fleet cites. */
  section: string;
  heading: string;
  title: string;
  body: string;
}

export interface RosterName {
  slug: string;
  en: string | null;
  ru: string | null;
  role: string | null;
}

// ---------------------------------------------------------------------------
// Fence-aware line walk
// ---------------------------------------------------------------------------

/**
 * Indexes of lines that are real markdown headings — fences excluded.
 * Returns [lineIndex, level, text] with text already stripped of the hashes.
 */
export function headingLines(text: string): Array<[number, number, string]> {
  const lines = text.split('\n');
  const out: Array<[number, number, string]> = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m || !m[1] || m[2] === undefined) continue;
    out.push([i, m[1].length, m[2].trim()]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Craft / memory entries
// ---------------------------------------------------------------------------

/**
 * Parse one `LEARNING.md` or `MEMORY.md` into entries.
 *
 * `##` and `###` are entries; `####` and deeper are body structure and are
 * swallowed into the entry above them. `[регистр]` headings are structural and
 * are skipped — §9g says outright they carry no condition.
 */
export function parseSeatFile(text: string): KgRecord[] {
  const lines = text.split('\n');
  const heads = headingLines(text).filter(([, level]) => level === 2 || level === 3);

  const out: KgRecord[] = [];
  for (let n = 0; n < heads.length; n++) {
    const head = heads[n];
    if (!head) continue;
    const [lineIdx, level, heading] = head;
    if (heading.includes('[регистр]')) continue;

    const pipe = heading.indexOf('|');
    const addressPart = (pipe >= 0 ? heading.slice(0, pipe) : heading).trim();
    const triggerLine = pipe >= 0 ? heading.slice(pipe + 1).trim() : null;

    let family: string | null = null;
    let dated: string | null = null;
    let address = addressPart;

    const fam = FAMILY_RE.exec(addressPart);
    if (fam && fam[1] && fam[2]) {
      family = fam[1];
      const d = fam[2];
      dated = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    } else {
      const own = OWN_NUMBER_RE.exec(addressPart);
      const bare = BARE_DATE_RE.exec(addressPart);
      if (own && own[1]) {
        family = own[1];
        // No date in the address, and none is invented: these entries are
        // numbered by the seat, not dated by it.
      } else if (bare) {
        dated = addressPart;
        family = 'DATE';
        // Two entries can share a bare date. Suffix by order of appearance so
        // they get two addresses instead of silently collapsing into one.
        address = `${addressPart}-${String(out.filter((r) => r.dated_on === addressPart).length + 1).padStart(2, '0')}`;
      } else {
        // A heading that is neither an id nor a date: keep it, addressed by its
        // own text. Inventing an id here would put a made-up address in front
        // of the reader — §0b forbids exactly that.
        family = null;
      }
    }

    const end = heads[n + 1]?.[0] ?? lines.length;
    const body = lines.slice(lineIdx + 1, end).join('\n').trim();

    out.push({ address, family, dated_on: dated, heading, triggerLine, body, level });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HARD_RULES sections
// ---------------------------------------------------------------------------

/**
 * Parse `HARD_RULES.md` into cited sections. The section number is what the
 * fleet writes in a body (`§8.1`), so that — not the title — is the node id.
 */
export function parseLawFile(text: string): KgLawSection[] {
  const lines = text.split('\n');
  const heads = headingLines(text).filter(([, level]) => level === 2 || level === 3);

  const out: KgLawSection[] = [];
  for (let n = 0; n < heads.length; n++) {
    const head = heads[n];
    if (!head) continue;
    const [lineIdx, , heading] = head;
    // `## 0b. Facts only …` · `## §9c — The latest …` · `## 9b.1 Язык`
    const m = /^§?\s*([0-9]+[a-z]*(?:[-.][0-9a-z]+)*)[.\s—-]/i.exec(heading);
    if (!m || !m[1]) continue;
    const section = m[1].toLowerCase();
    const title = heading.slice(m[0].length).trim() || heading;
    const end = heads[n + 1]?.[0] ?? lines.length;
    const body = lines.slice(lineIdx + 1, end).join('\n').trim();
    if (out.some((s) => s.section === section)) continue; // first wins, no double address
    out.push({ section, heading, title, body });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Roster names — read from the org's own registry, never invented
// ---------------------------------------------------------------------------

/**
 * Pull `ROSTER_CANON` out of `api/roster-names.mjs` without executing it.
 *
 * Why parse rather than hardcode: two lists of the same names drift silently,
 * and the drift surfaces as a seat that answers in chat but is missing from
 * every graph. The org keeps one list; this reads that one.
 *
 * A seat with no line there gets `ru: null` and is reported as a gap — it is
 * never given a Cyrillic form guessed from its slug, because a slug only ever
 * yields latin.
 */
export function parseRosterNames(source: string): RosterName[] {
  const out: RosterName[] = [];
  const re = /\{\s*slug:\s*"([^"]+)"([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const slug = m[1];
    const rest = m[2] ?? '';
    if (!slug) continue;
    const pick = (key: string): string | null => {
      const k = new RegExp(`${key}:\\s*"([^"]*)"`).exec(rest);
      return k?.[1] ?? null;
    };
    out.push({ slug, en: pick('en'), ru: pick('ru'), role: pick('role') });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edge extraction
// ---------------------------------------------------------------------------

/** Law sections cited anywhere in a text. Lower-cased, de-duplicated. */
export function citedLaws(text: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  LAW_CITE_RE.lastIndex = 0;
  while ((m = LAW_CITE_RE.exec(text)) !== null) {
    if (m[1]) found.add(m[1].toLowerCase().replace(/[.,;:]$/, ''));
  }
  return [...found];
}

/** Other entries cited by their address. */
export function citedRecords(text: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  RECORD_CITE_RE.lastIndex = 0;
  while ((m = RECORD_CITE_RE.exec(text)) !== null) found.add(m[0]);
  return [...found];
}

/**
 * Latin working terms of a trigger line — the topics an entry is about.
 * Capped at eight: a trigger line longer than that is two entries, not one
 * topic-rich one, and §9g already says to split it rather than shorten it.
 */
export function topicsOf(triggerLine: string | null): Array<{ id: string; label: string }> {
  if (!triggerLine) return [];
  const seen = new Map<string, string>();
  let m: RegExpExecArray | null;
  TOPIC_RE.lastIndex = 0;
  while ((m = TOPIC_RE.exec(triggerLine)) !== null) {
    const raw = m[0];
    const id = raw.toLowerCase();
    if (TOPIC_STOP.has(id)) continue;
    if (!/\d/.test(raw) && raw.length < 3) continue;
    if (!seen.has(id)) seen.set(id, raw);
    if (seen.size >= 8) break;
  }
  return [...seen].map(([id, label]) => ({ id, label }));
}

/**
 * Russian case endings a first name actually takes. A closed list, not «any
 * three letters»: the loose version matched «Минами» (instrumental plural of a
 * common noun) while missing «Мине», because a case ending REPLACES the final
 * vowel rather than following it. Wrong in both directions at once.
 */
const CASE_ENDINGS = ['', 'а', 'я', 'ы', 'и', 'е', 'у', 'ю', 'ой', 'ей', 'ою', 'ею', 'ом', 'ем'];

/** Escape a literal for use inside a RegExp. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A name as a pattern that also matches its declined forms.
 *
 * EVERY Cyrillic word declines, not only the last one: «Виктор Палыч» becomes
 * «Виктору Палычу», and a rule that inflected the surname alone found neither.
 * A latin word is matched as written — English does not decline, and bolting
 * Russian endings onto it would only invent matches.
 */
function nameForms(form: string): string {
  return form
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (!/[А-Яа-яЁё]/.test(word)) return escapeRe(word);
      // Drop a trailing vowel or soft sign: that letter belongs to the ending,
      // not to the stem, which is why «Мина» has to match «Мине».
      const stem = /[аяьеиоуыю]$/i.test(word) ? word.slice(0, -1) : word;
      const alts = CASE_ENDINGS.map((e) => escapeRe(stem + e)).sort((a, b) => b.length - a.length);
      return `(?:${alts.join('|')})`;
    })
    .join('\\s+');
}

/**
 * Seats named in a text. Matching is by the forms the org's own registry
 * carries — latin and, where the registry has one, Cyrillic. Cyrillic word
 * boundaries are built by hand: JS `\b` is latin-only and would match inside
 * a Russian word.
 */
export function mentionedSeats(text: string, roster: RosterName[], selfSlug: string): string[] {
  const found = new Set<string>();
  for (const seat of roster) {
    if (seat.slug === selfSlug) continue;
    const forms: string[] = [];
    if (seat.en) forms.push(seat.en);
    if (seat.ru) forms.push(seat.ru);
    for (const form of forms) {
      const re = new RegExp(`(?<![A-Za-zА-Яа-яЁё])${nameForms(form)}(?![A-Za-zА-Яа-яЁё])`, 'u');
      if (re.test(text)) {
        found.add(seat.slug);
        break;
      }
    }
  }
  return [...found];
}

// =============================================================================
// kg-parse — regression lock.
//
// Run: bash scripts/check-knowledge-parser.sh   (also runs in the repo guard)
//
// Fixtures are written here by hand and are NOT copies of the organizacia
// corpus. Copying the corpus in would make this repo a second place the craft
// lives, and the two would drift; what belongs here is the SHAPE the parser
// must survive, which is stable even when the entries change.
//
// Every case below is a defect this parser actually had, caught by calling it
// against the live corpus rather than by reading it:
//   * `LEARN-…` parsed as familyless, because the family list was closed;
//   * «Мине» did not match Мина while «Минами» did, because the case ending
//     replaces the final vowel instead of following it;
//   * «Виктору Палычу» matched neither word, because only the surname declined.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseSeatFile, parseLawFile, parseRosterNames,
  citedLaws, citedRecords, topicsOf, mentionedSeats,
} = await import(new URL('../../.kg-build/kg-parse.js', import.meta.url).href);

const ROSTER = parseRosterNames(`
  export const ROSTER_CANON = [
    { slug: "viktor-palich", en: "Viktor Palich", ru: "Виктор Палыч", role: "General Director", male: true },
    { slug: "mina-rutunya", en: "Mina Rutunya", ru: "Мина", role: "Sysadmin · IT" },
    { slug: "lisa", en: "Lisa", ru: "Лиза", role: "Designer" }
  ];
`);

// ---------------------------------------------------------------------------
test('roster registry is read, not guessed', () => {
  assert.equal(ROSTER.length, 3);
  assert.deepEqual(ROSTER[1], { slug: 'mina-rutunya', en: 'Mina Rutunya', ru: 'Мина', role: 'Sysadmin · IT' });
});

// ---------------------------------------------------------------------------
test('a family the list never heard of is still a family', () => {
  // §9g: «или своя семья места, где она уже есть». A closed list demotes those
  // entries to familyless and drops them out of every family filter.
  const [rec] = parseSeatFile('## LEARN-20260819-01 | если публикуешь ряд — подели сумму');
  assert.equal(rec.family, 'LEARN');
  assert.equal(rec.dated_on, '2026-08-19');
  assert.equal(rec.triggerLine, 'если публикуешь ряд — подели сумму');
});

test("a seat's own numbering is a family, not a hole", () => {
  // §9g: «Свои номера по строю не перенумеровываются». EV-01 (Taras), M1
  // (Tamara), JW-005 (Jurgen) carry a family and no date. Requiring a date in
  // the address read 78 live entries as familyless.
  const recs = parseSeatFile([
    '## EV-01 | если возраст в кадре читается спорно — стоп',
    '## M12 | если называешь товар покупателю — человеческое имя',
    '## JW-005 | если два писателя правят один файл — жди расхождения',
  ].join('\n'));
  assert.deepEqual(recs.map((r) => r.family), ['EV', 'M', 'JW']);
  assert.deepEqual(recs.map((r) => r.dated_on), [null, null, null]);
  assert.deepEqual(recs.map((r) => r.address), ['EV-01', 'M12', 'JW-005']);
});

test('a heading inside a fence is text, not a heading', () => {
  const src = '## A-20260101-01 | если A — делай B\n```\n## B-20260101-01 | не запись\n```\ntail';
  assert.deepEqual(parseSeatFile(src).map((r) => r.address), ['A-20260101-01']);
});

test('[регистр] is structure and carries no condition', () => {
  assert.equal(parseSeatFile('## [регистр] SEALED 2026-08-18\nbody').length, 0);
});

test('#### is body structure, swallowed by the entry above it', () => {
  const recs = parseSeatFile('## A-20260101-01 | если A — делай B\n#### Rollback\nrevert it');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].body, '#### Rollback\nrevert it');
});

test('the legacy bare-date address does not collapse two entries into one', () => {
  const recs = parseSeatFile('## 2026-07-30 | первое\n## 2026-07-30 | второе');
  assert.deepEqual(recs.map((r) => r.address), ['2026-07-30-01', '2026-07-30-02']);
  assert.deepEqual(recs.map((r) => r.family), ['DATE', 'DATE']);
});

// ---------------------------------------------------------------------------
test('law sections are addressed by the number the fleet cites', () => {
  const src = [
    '## 0b. Facts only — zero inventions',
    'body of 0b, which points at §8.1',
    '## 8.1 Выкат в Cloudflare — только с origin/main',
    'body of 8.1',
    '## §9c — The latest summary wins',
    'body of 9c',
  ].join('\n');
  const sections = parseLawFile(src);
  assert.deepEqual(sections.map((s) => s.section), ['0b', '8.1', '9c']);
  assert.equal(sections[0].title, 'Facts only — zero inventions');
});

test('two headings claiming one section number leave one address', () => {
  const src = '## 0b. First claim\na\n## 0b. Second claim\nb';
  assert.equal(parseLawFile(src).length, 1);
});

// ---------------------------------------------------------------------------
test('law citations are found in every form the fleet writes them', () => {
  assert.deepEqual(citedLaws('см. §8.1 и §0c-1, дальше §9g.').sort(), ['0c-1', '8.1', '9g']);
  assert.deepEqual(citedLaws('HARD_RULES §4h запрещает').sort(), ['4h']);
});

test('entry-to-entry citations are found by address', () => {
  assert.deepEqual(
    citedRecords('рядом с LAW-20260730-01 и MEM-20260101-02'),
    ['LAW-20260730-01', 'MEM-20260101-02']
  );
});

test('topics are the latin working terms of the trigger line', () => {
  assert.deepEqual(
    topicsOf('если hreflang сломан на 404 — правь landed-cost').map((t) => t.label),
    ['hreflang', '404', 'landed-cost']
  );
  assert.deepEqual(topicsOf(null), []);
  // A Cyrillic-only trigger yields nothing, and that is the §9d «безлат» gap
  // showing through rather than a parser failure.
  assert.deepEqual(topicsOf('если выкат перезапишет живую поверхность — сними живое'), []);
});

// ---------------------------------------------------------------------------
test('a Russian name is matched through its cases', () => {
  for (const form of ['Мина выкатила', 'решение Мины', 'Мине передано', 'говорил с Миной']) {
    assert.deepEqual(mentionedSeats(form, ROSTER, 'x'), ['mina-rutunya'], form);
  }
});

test('a word that merely starts like a name is not a seat', () => {
  // «Минами» is the instrumental plural of a common noun. The loose «any three
  // letters» rule matched it and missed «Мине» — wrong in both directions.
  assert.deepEqual(mentionedSeats('Проверка Минами', ROSTER, 'x'), []);
  assert.deepEqual(mentionedSeats('администратор системы', ROSTER, 'x'), []);
  assert.deepEqual(mentionedSeats('лизать не надо', ROSTER, 'x'), []);
});

test('both words of a two-word name decline', () => {
  assert.deepEqual(mentionedSeats('передано Виктору Палычу', ROSTER, 'x'), ['viktor-palich']);
  assert.deepEqual(mentionedSeats('Виктор Палыч поймал', ROSTER, 'x'), ['viktor-palich']);
});

test('a latin name is matched as written', () => {
  assert.deepEqual(mentionedSeats('handed to Mina Rutunya', ROSTER, 'x'), ['mina-rutunya']);
});

test('a seat is never linked to itself', () => {
  assert.deepEqual(mentionedSeats('Мина выкатила', ROSTER, 'mina-rutunya'), []);
});

test('the 2026-08-28 address form: seat code, family, six-digit day', () => {
  // HARD_RULES §9g (Owner 2026-08-28): `МЕСТО-KIND-ГГММДД-NN`. The seat code is
  // part of the address; family is the middle word; the day expands to a date.
  const recs = parseSeatFile([
    '## JW-LAW-260827-01 | если одна ошибка формы показана дважды — считай один раз',
    '## CS-MEM-260828-03 | если WB отвечает 429 — это лимит площадки',
    '## TR-EV-12 | если в брифе жидкости — непрерывны во времени',
    '## TR-SR-01 | если генерируешь бренд-визуал — путь Higgsfield',
    '## LZ-2a | если меняешь стиль — процедура та же',
    '## JW-010-A | если ключ вроде бы выложен — дыра в ветке',
    '## CS-1 | если заявляешь свойство продукта — только из product-skill',
  ].join('\n'));
  assert.deepEqual(recs.map((r) => r.family), ['LAW', 'MEM', 'EV', 'SR', 'LZ', 'JW', 'CS']);
  assert.deepEqual(recs.map((r) => r.dated_on), ['2026-08-27', '2026-08-28', null, null, null, null, null]);
  assert.deepEqual(recs.map((r) => r.address), ['JW-LAW-260827-01', 'CS-MEM-260828-03', 'TR-EV-12', 'TR-SR-01', 'LZ-2a', 'JW-010-A', 'CS-1']);
});

test('citations carry the seat code in the new form and still parse the legacy one', () => {
  assert.deepEqual(
    citedRecords('см. JW-LAW-260827-01, рядом MEM-20260101-02 и VL-LEG-260720-01'),
    ['JW-LAW-260827-01', 'MEM-20260101-02', 'VL-LEG-260720-01']
  );
});

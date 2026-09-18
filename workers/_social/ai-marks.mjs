/**
 * Layer A — снятие невидимых меток модели с текста, который пишет агент.
 *
 * Владелец 05.09.2026: «убрать водяные знаки у агентов, которые создают тексты»,
 * ссылка — github.com/guillaumemeyer/watermarks-remover (MIT). Оттуда взят
 * СОСТАВ множества (какие кодовые точки считаются носителем), а не код: у нас
 * Workers, Python в рантайме нет. Портирован детерминированный слой A —
 * невидимые форматные символы, служебные (noncharacter), зарезервированные
 * default-ignorable, private-use, теговые символы и селекторы начертания.
 *
 * Чего этот файл НЕ делает и не обещает:
 *   — не переписывает текст (слой B — стилометрия и перефраз — остаётся ремеслом
 *     пишущего места и скиллом `humanizer`, здесь его нет);
 *   — не снимает ключевую статистическую метку (SynthID-Text, KGW): её нельзя
 *     ни увидеть, ни проверить локально, и обещать её снятие значило бы врать (§0b);
 *   — не чистит метаданные файлов (C2PA / EXIF / XMP) — это картинки и PDF,
 *     другой слой и другое место.
 *
 * Умолчания выбраны консервативно, ровно как рекомендует апстрим-скилл:
 *   normalizeSpaces=false — NBSP и узкий неразрывный несут вёрстку («10 000 ₽»,
 *     «т. е.»), их подмена на пробел меняет вид текста, а не прячет метку;
 *   stripBidi=false — направляющие метки и изоляты (LRM/RLM/FSI…) законны в
 *     смешанном RTL-тексте; перекрытия (LRO/RLO/LRE/RLE/PDF) снимаются всегда,
 *     потому что они переставляют чужие куски;
 *   stripEmojiGlue=false — ZWJ и VS16 после эмодзи держат видимый знак (❤️, 👨‍👩‍👧);
 *     свободно висящие — снимаются.
 *
 * Откат: удалить вызовы `stripAiMarks` на швах (day-runtime.think, api chat/mail)
 * и этот файл. Ни состояния, ни миграции, ни ключа за собой не оставляет.
 */

/** Форматные / невидимые символы — типовые носители метки и мусор вставки. */
const STRIP_CODEPOINTS = new Set([
  0x00ad, // soft hyphen
  0x034f, // combining grapheme joiner
  0x115f, 0x1160, // Hangul choseong/jungseong filler
  0x17b4, 0x17b5, // Khmer vowel inherent AQ/AA
  0x180b, 0x180c, 0x180d, 0x180e, 0x180f, // Mongolian FVS 1-4 + vowel separator
  0x200b, 0x200c, 0x200d, // ZWSP, ZWNJ, ZWJ
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE, RLE, PDF, LRO, RLO
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner, invisible operators
  0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, // deprecated format controls
  0x3164, 0xffa0, // Hangul filler (пустой видимый знак)
  0xfeff, // BOM / ZWNBSP
  0xfff9, 0xfffa, 0xfffb, // interlinear annotation
]);

/** Направляющие метки и изоляты: законны в смешанном тексте, снимаются по флагу. */
const BIDI_PRESERVABLE = new Set([0x061c, 0x200e, 0x200f, 0x2066, 0x2067, 0x2068, 0x2069]);

/** Клей эмодзи: невидим сам по себе, но держит видимую последовательность. */
const EMOJI_GLUE = new Set([0x200d, 0xfe0e, 0xfe0f]);

/** Пробелы-двойники U+0020. Меняются только по явному normalizeSpaces. */
const SPACE_HOMOGLYPHS = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
]);

/**
 * Незанятые точки с Other_Default_Ignorable_Code_Point=Yes: рендерер обязан
 * показывать их пустотой, нормализация их сохраняет — идеальный носитель.
 * Держим списком, а не правилом «категория Cn»: Unicode дозаписывают, и правило
 * по категории однажды съест настоящую букву (так U+180F стал монгольским FVS4).
 */
const RESERVED_IGNORABLE = new Set([0x2065, 0xe0000]);
const RESERVED_IGNORABLE_RANGES = [
  [0xfff0, 0xfff8],
  [0xe0080, 0xe00ff],
  [0xe01f0, 0xe0fff],
];

function inRanges(cp, ranges) {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** 66 служебных точек Unicode: в обмене запрещены (TUS 23.7) — значит контрабанда. */
function isNoncharacter(cp) {
  return (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;
}

/** Частные области: смысла вне договорённости не несут. */
function isPrivateUse(cp) {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  );
}

/** Селекторы начертания: FE00-FE0F и дополнение VS17-VS256. */
function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

/** Теговые символы U+E0001..U+E007F — прямой канал стеганографии. */
function isTagChar(cp) {
  return cp >= 0xe0001 && cp <= 0xe007f;
}

/** Может ли символ начинать или продолжать эмодзи-последовательность. */
function isEmojiBase(cp) {
  if (cp >= 0x1f000 && cp <= 0x1faff) return true; // эмодзи, флаги, тона кожи
  if (cp >= 0x2190 && cp <= 0x25ff) return true; // стрелки, тех. знаки
  if (cp >= 0x2600 && cp <= 0x27bf) return true; // символы, дингбаты
  if (cp >= 0x2b00 && cp <= 0x2bff) return true;
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true; // модификаторы тона
  return [0x203c, 0x2049, 0x2139, 0x2934, 0x2935, 0x00a9, 0x00ae, 0x2122,
    0x3030, 0x303d, 0x3297, 0x3299].includes(cp);
}

/** Как назвать снятый символ в отчёте. Имя — для журнала, не для решения. */
function markKind(cp) {
  if (isTagChar(cp)) return "tag_chars";
  if (isNoncharacter(cp)) return "noncharacter";
  if (RESERVED_IGNORABLE.has(cp) || inRanges(cp, RESERVED_IGNORABLE_RANGES)) return "reserved_ignorable";
  if (isVariationSelector(cp)) return "variation_selector";
  if (BIDI_PRESERVABLE.has(cp) || (cp >= 0x202a && cp <= 0x202e)) return "bidi";
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) return "zero_width";
  if (isPrivateUse(cp)) return "private_use";
  if (SPACE_HOMOGLYPHS.has(cp)) return "space_homoglyph";
  return "format_control";
}

function isStripCandidate(cp) {
  return (
    STRIP_CODEPOINTS.has(cp) ||
    BIDI_PRESERVABLE.has(cp) ||
    isVariationSelector(cp) ||
    isTagChar(cp) ||
    isNoncharacter(cp) ||
    RESERVED_IGNORABLE.has(cp) ||
    inRanges(cp, RESERVED_IGNORABLE_RANGES) ||
    isPrivateUse(cp)
  );
}

/**
 * Один проход по кодовым точкам. Возвращает и чистый текст, и счёт снятого —
 * чтобы шов мог сказать в журнал, ЧТО он снял, а не «почищено» (§0b).
 *
 * @param {string} text
 * @param {{normalizeSpaces?:boolean, stripBidi?:boolean, stripEmojiGlue?:boolean}} [opts]
 * @returns {{ text: string, removed: number, replaced: number, kinds: Record<string, number> }}
 */
export function cleanAiMarks(text, opts = {}) {
  const src = String(text ?? "");
  const normalizeSpaces = opts.normalizeSpaces === true;
  const stripBidi = opts.stripBidi === true;
  const stripEmojiGlue = opts.stripEmojiGlue === true;

  const chars = Array.from(src);
  const cps = chars.map((ch) => ch.codePointAt(0));
  const out = [];
  // Обычный объект, не Object.create(null): ключи здесь из закрытого списка
  // markKind, а вид без прототипа не переживает ни deepStrictEqual, ни разбор
  // на другом конце журнала.
  const kinds = {};
  let removed = 0;
  let replaced = 0;

  const note = (cp) => {
    const k = markKind(cp);
    kinds[k] = (kinds[k] || 0) + 1;
  };

  // Соседи ищутся мимо уже снятого клея: «эмодзи + VS16 + ZWJ + эмодзи» должно
  // читаться как одна последовательность, а не рассыпаться на первом же шаге.
  const baseBefore = (i) => {
    for (let j = i - 1; j >= 0; j--) {
      if (EMOJI_GLUE.has(cps[j])) continue;
      return isEmojiBase(cps[j]);
    }
    return false;
  };
  const baseAfter = (i) => {
    for (let j = i + 1; j < cps.length; j++) {
      if (EMOJI_GLUE.has(cps[j])) continue;
      return isEmojiBase(cps[j]);
    }
    return false;
  };

  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];

    if (SPACE_HOMOGLYPHS.has(cp)) {
      if (normalizeSpaces) {
        out.push(" ");
        replaced += 1;
        note(cp);
      } else {
        out.push(chars[i]);
      }
      continue;
    }

    if (EMOJI_GLUE.has(cp) && !stripEmojiGlue) {
      // ZWJ держит склейку только между двумя эмодзи; селектор — только после базы.
      const held = cp === 0x200d ? baseBefore(i) && baseAfter(i) : baseBefore(i);
      if (held) {
        out.push(chars[i]);
        continue;
      }
    }

    if (BIDI_PRESERVABLE.has(cp) && !stripBidi) {
      out.push(chars[i]);
      continue;
    }

    if (isStripCandidate(cp)) {
      removed += 1;
      note(cp);
      continue;
    }

    out.push(chars[i]);
  }

  return { text: out.join(""), removed, replaced, kinds };
}

/**
 * Тот же проход, но возвращает только текст — вид для швов, где чистка обязана
 * быть незаметной и не может ничего сломать. Пустое и не-строка проходят насквозь.
 *
 * @param {string} text
 * @param {{normalizeSpaces?:boolean, stripBidi?:boolean, stripEmojiGlue?:boolean}} [opts]
 * @returns {string}
 */
export function stripAiMarks(text, opts = {}) {
  if (text == null) return text;
  if (typeof text !== "string") return text;
  if (!text) return text;
  return cleanAiMarks(text, opts).text;
}

/**
 * Считает метки, ничего не меняя — для линта и отчёта. `clean: true` означает
 * «носителей не найдено», а не «текст написан человеком»: второго этот файл
 * не измеряет и измерять не может.
 *
 * @param {string} text
 * @returns {{ clean: boolean, count: number, kinds: Record<string, number> }}
 */
export function scanAiMarks(text) {
  const { removed, kinds } = cleanAiMarks(text);
  return { clean: removed === 0, count: removed, kinds };
}

/**
 * Рекурсивная чистка строк внутри разобранного ответа модели: место просит у
 * think() JSON, метка сидит в его строковых полях, и чистить только «сырой»
 * ответ значило бы чистить всё, кроме того, что реально уедет читателю.
 * Ключи объекта не трогаются — они машинные и по ним разбирают.
 *
 * @template T
 * @param {T} value
 * @param {{normalizeSpaces?:boolean, stripBidi?:boolean, stripEmojiGlue?:boolean}} [opts]
 * @returns {T}
 */
export function stripAiMarksDeep(value, opts = {}) {
  if (typeof value === "string") return stripAiMarks(value, opts);
  if (Array.isArray(value)) return value.map((v) => stripAiMarksDeep(v, opts));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripAiMarksDeep(v, opts);
    return out;
  }
  return value;
}

// A blogger on /ugc is a person and a city (Owner 2026-10-16): «надо именно имя…
// Всё остальное: beauty, travel-блогер… нам не интересно»; «Город нужен, город
// обязательно». From an Instagram profile name keep only the person:
// «Life blog| рецепты| распаковки» → '', «Рукият| Life blog| Находки» → «Рукият»,
// «ЮЛИЯ» → «Юлия»; the city comes separately (cityOf). No person → ''.

const TOPIC = /(blog|блог|обзор|распак|наход|^wb$|^вб$|wildberr|willdber|валбер|ozon|озон|life|лайф|style|стил|family|семья|материн|мама|^мам|mom|kids|сотруднич|ugc|контент|content|уют|^дом$|рецепт|food|игры|развит|покуп|shop|магазин|маникюр|nail|ресниц|бомбоч|обучени|парфюм|^бар$|окрашив|hair|репетит|english|астролог|худеет|тренд|подборк|декрет|менеджер|юмор|деревн|вдохнов|визуализ|модель|beauty|бьюти|travel|тревел|strong|сельск|готовк|визаж|косметик|отзыв|ремонт|животн|путешеств|фитнес|fitness|спорт|психолог|нутрициол|дизайн|фото|photo|video|видео|reels|рилс|trend|unboxing|review|одежд|жизн|продолж|девушк|работ|бизнес|эксперт|мастер|салон|студи)/i;

// Regions end a name but are not a city.
const REGIONS = new Set(['крым', 'башкирия', 'дагестан', 'чечня', 'татарстан', 'кубань', 'урал', 'сибирь', 'россия', 'казахстан', 'беларусь']);

// Stem → city. Latin spellings and common short forms map to the Russian name.
const CITIES = [
  ['москв', 'Москва'], ['moscow', 'Москва'], ['moskva', 'Москва'], ['мск', 'Москва'],
  ['петербург', 'Санкт-Петербург'], ['спб', 'Санкт-Петербург'], ['питер', 'Санкт-Петербург'], ['spb', 'Санкт-Петербург'],
  ['новосибирск', 'Новосибирск'], ['екатеринбург', 'Екатеринбург'], ['екб', 'Екатеринбург'], ['казан', 'Казань'], ['kazan', 'Казань'],
  ['челябинск', 'Челябинск'], ['самар', 'Самара'], ['samara', 'Самара'], ['омск', 'Омск'],
  ['ростов', 'Ростов-на-Дону'], ['уфа', 'Уфа'], ['уфы', 'Уфа'], ['красноярск', 'Красноярск'], ['воронеж', 'Воронеж'], ['пермь', 'Пермь'], ['перми', 'Пермь'],
  ['волгоград', 'Волгоград'], ['краснодар', 'Краснодар'], ['krasnodar', 'Краснодар'], ['krd', 'Краснодар'], ['саратов', 'Саратов'], ['тюмен', 'Тюмень'], ['tyumen', 'Тюмень'],
  ['тольятти', 'Тольятти'], ['ижевск', 'Ижевск'], ['барнаул', 'Барнаул'], ['ульяновск', 'Ульяновск'], ['иркутск', 'Иркутск'], ['хабаровск', 'Хабаровск'],
  ['ярославл', 'Ярославль'], ['владивосток', 'Владивосток'], ['махачкал', 'Махачкала'], ['makhachkala', 'Махачкала'], ['томск', 'Томск'], ['оренбург', 'Оренбург'],
  ['кемерово', 'Кемерово'], ['новокузнецк', 'Новокузнецк'], ['рязан', 'Рязань'], ['астрахан', 'Астрахань'], ['пенз', 'Пенза'],
  ['киров', 'Киров'], ['липецк', 'Липецк'], ['чебоксар', 'Чебоксары'], ['калининград', 'Калининград'], ['курск', 'Курск'], ['ставропол', 'Ставрополь'], ['stavropol', 'Ставрополь'],
  ['сочи', 'Сочи'], ['sochi', 'Сочи'], ['твер', 'Тверь'], ['магнитогорск', 'Магнитогорск'], ['иваново', 'Иваново'], ['брянск', 'Брянск'], ['белгород', 'Белгород'],
  ['сургут', 'Сургут'], ['архангельск', 'Архангельск'], ['калуг', 'Калуга'], ['смоленск', 'Смоленск'], ['волжск', 'Волжский'],
  ['курган', 'Курган'], ['череповец', 'Череповец'], ['вологд', 'Вологда'], ['саранск', 'Саранск'], ['владикавказ', 'Владикавказ'],
  ['якутск', 'Якутск'], ['мурманск', 'Мурманск'], ['подольск', 'Подольск'], ['тамбов', 'Тамбов'], ['грозн', 'Грозный'], ['стерлитамак', 'Стерлитамак'], ['костром', 'Кострома'],
  ['петрозаводск', 'Петрозаводск'], ['нижневартовск', 'Нижневартовск'], ['новороссийск', 'Новороссийск'], ['таганрог', 'Таганрог'],
  ['сыктывкар', 'Сыктывкар'], ['syktyvkar', 'Сыктывкар'], ['нальчик', 'Нальчик'], ['дзержинск', 'Дзержинск'], ['братск', 'Братск'],
  ['ангарск', 'Ангарск'], ['энгельс', 'Энгельс'], ['благовещенск', 'Благовещенск'], ['псков', 'Псков'], ['бийск', 'Бийск'],
  ['армавир', 'Армавир'], ['пятигорск', 'Пятигорск'], ['дербент', 'Дербент'], ['каспийск', 'Каспийск'], ['хасавюрт', 'Хасавюрт'], ['буйнакск', 'Буйнакск'], ['кизляр', 'Кизляр'],
  ['черкесск', 'Черкесск'], ['майкоп', 'Майкоп'], ['элист', 'Элиста'], ['назрань', 'Назрань'], ['бердск', 'Бердск'], ['симферопол', 'Симферополь'], ['севастопол', 'Севастополь'],
  ['анап', 'Анапа'], ['геленджик', 'Геленджик'], ['кисловодск', 'Кисловодск'], ['ессентук', 'Ессентуки'], ['норильск', 'Норильск'],
  ['минск', 'Минск'], ['алмат', 'Алматы'], ['астана', 'Астана'], ['ереван', 'Ереван'], ['ташкент', 'Ташкент'], ['бишкек', 'Бишкек'], ['баку', 'Баку'], ['тбилиси', 'Тбилиси'],
];
// Short forms match only as a whole word.
const SHORT_EXACT = new Set(['мск', 'спб', 'екб', 'krd', 'spb', 'уфа', 'уфы', 'баку', 'омск']);
const PHRASES = [['нижний новгород', 'Нижний Новгород'], ['нижнем новгороде', 'Нижний Новгород'], ['набережные челны', 'Набережные Челны'], ['великий новгород', 'Великий Новгород'], ['санкт-петербург', 'Санкт-Петербург'], ['улан-удэ', 'Улан-Удэ'], ['йошкар-ола', 'Йошкар-Ола']];

/** The city named in a text (profile name, handle or a message), or ''. */
export function cityOf(text) {
  const lower = String(text ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е');
  for (const [phrase, city] of PHRASES) if (lower.includes(phrase)) return city;
  for (const word of lower.split(/[^\p{L}-]+/u).filter(Boolean)) {
    for (const [stem, city] of CITIES) {
      if (SHORT_EXACT.has(stem) ? word === stem : word.startsWith(stem) && word.length - stem.length <= 3) return city;
      // Latin stems inside a handle: «irinkaanik_stavropol31», «valeri__bloggerkrd» is too short to trust.
      if (/^[a-z]{6,}$/.test(stem) && word.includes(stem)) return city;
    }
  }
  return '';
}

const SEP = /[|/•·~&+,;:!?()[\]{}«»"“”]|\s[-–—]\s|\p{Extended_Pictographic}|️|‍/u;

const script = (w) => (/[а-яё]/i.test(w) ? 'cyr' : /[a-z]/i.test(w) ? 'lat' : '');
const title = (w) => w.split('-').map((p) => p.charAt(0).toLocaleUpperCase('ru') + p.slice(1).toLocaleLowerCase('ru')).join('-');

/** The person's name inside a profile name, or '' when there is none. */
export function personName(raw) {
  if (typeof raw !== 'string' || !raw.trim() || /https?:|www\.|@/i.test(raw)) return '';
  for (const segment of raw.split(SEP)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const allLower = words.every((x) => x === x.toLocaleLowerCase('ru'));
    const out = [];
    for (const word of words) {
      const w = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (!w) continue;
      if (/[\d_]/.test(word) || w.includes('.') || w.length < 2 || !/^[\p{L}-]+$/u.test(w)) { if (out.length) break; continue; }
      // Topic words, regions and cities are skipped before the name and end it after.
      if (TOPIC.test(w) || REGIONS.has(w.toLocaleLowerCase('ru')) || cityOf(w)) { if (out.length) break; continue; }
      if (out.length && script(w) !== script(out[0])) break;
      // Name words start with a capital; a lowercase word after one ends the name,
      // unless the whole segment is lowercase («ксенья клепикова»).
      const upper = w.charAt(0) !== w.charAt(0).toLocaleLowerCase('ru');
      if (out.length && !upper && !allLower) break;
      out.push(title(w));
      if (out.length === 3) break;
    }
    if (out.length) return out.join(' ');
  }
  return '';
}

/**
 * Surname from payout requisites only when the card is the blogger's own: the
 * card's first name equals the name we already have (Owner 2026-10-16: «если дают
 * карту мужа… имя мужа не надо на нее ставить»).
 */
export function withSurname(name, requisites) {
  const first = String(name || '').split(' ')[0];
  const cardFirst = String(requisites?.first_name || '').trim();
  const cardLast = String(requisites?.last_name || '').trim();
  if (!first || !cardFirst || !cardLast) return name || '';
  if (first.toLocaleLowerCase('ru') !== cardFirst.toLocaleLowerCase('ru')) return name;
  if (String(name).split(' ').length > 1) return name;
  return `${title(cardFirst)} ${title(cardLast)}`;
}

// First names that show up inside handles (Owner 2026-10-16: «amina_axmedova19 —
// там уже понятно, что Амина - это имя»). Longest match first.
const HANDLE_NAMES = Object.entries({
  amina: 'Амина', alina: 'Алина', aline: 'Алина', irina: 'Ирина', irinka: 'Ирина', polina: 'Полина', anastasia: 'Анастасия', anastasiya: 'Анастасия', nastya: 'Настя',
  ekaterina: 'Екатерина', katya: 'Катя', katerina: 'Катерина', maria: 'Мария', mariya: 'Мария', masha: 'Маша', anna: 'Анна', anya: 'Аня', anyuta: 'Анюта', olga: 'Ольга', olya: 'Оля',
  elena: 'Елена', natalia: 'Наталья', natalya: 'Наталья', natalie: 'Наталья', natasha: 'Наташа', tatiana: 'Татьяна', tatyana: 'Татьяна', tanya: 'Таня', svetlana: 'Светлана', sveta: 'Света',
  yulia: 'Юлия', yuliya: 'Юлия', julia: 'Юлия', iylia: 'Юлия', ksenia: 'Ксения', kseniya: 'Ксения', daria: 'Дарья', darya: 'Дарья', dasha: 'Даша', victoria: 'Виктория', viktoria: 'Виктория', viktoriya: 'Виктория', vika: 'Вика',
  sofia: 'София', diana: 'Диана', aisha: 'Айша', aishat: 'Айшат', madina: 'Мадина', zarina: 'Зарина', zalina: 'Залина', fatima: 'Фатима', patimat: 'Патимат', leila: 'Лейла', leyla: 'Лейла',
  liana: 'Лиана', lada: 'Лада', larisa: 'Лариса', lyubov: 'Любовь', regina: 'Регина', yasmin: 'Ясмин', sadiya: 'Садия', eseniya: 'Есения', marina: 'Марина', valeria: 'Валерия', valeri: 'Валерия',
  veronika: 'Вероника', evgenia: 'Евгения', evgeniya: 'Евгения', kristina: 'Кристина', karina: 'Карина', alena: 'Алёна', alyona: 'Алёна', oksana: 'Оксана', nadya: 'Надя', nadezhda: 'Надежда',
  vera: 'Вера', inna: 'Инна', rukiyat: 'Рукият', saida: 'Саида', ilona: 'Илона', elvira: 'Эльвира', gulnaz: 'Гульназ', aliya: 'Алия', lilia: 'Лилия', liliya: 'Лилия', yana: 'Яна', sumaya: 'Сумая',
  elizaveta: 'Елизавета', liza: 'Лиза', ira: 'Ира', margarita: 'Маргарита', evelina: 'Эвелина', selmaia: 'Селмая', selmaya: 'Селмая', zinaida: 'Зинаида', milana: 'Милана', amira: 'Амира',
}).sort((a, b) => b[0].length - a[0].length);

/** A first name readable from the handle («amina_axmedova19» → «Амина»), or ''. */
export function handleName(handle) {
  const parts = String(handle ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const part of parts) for (const [latin, name] of HANDLE_NAMES) if (part === latin || (part.startsWith(latin) && latin.length >= 5)) return name;
  return '';
}

/**
 * The name shown after the @handle: the person from the profile name, completed
 * from the handle when the profile has only an initial, a surname or Latin letters.
 */
export function bloggerName(profileName, handle) {
  let fromProfile = personName(profileName);
  // A lone Latin first name reads in Russian: «LARISA» → «Лариса».
  if (fromProfile && !fromProfile.includes(' ') && script(fromProfile) === 'lat') fromProfile = handleName(fromProfile) || fromProfile;
  const fromHandle = handleName(handle);
  if (!fromProfile) return fromHandle;
  if (!fromHandle) return fromProfile;
  const initial = String(profileName).match(/(?:^|[^\p{L}])(\p{Lu})\.\s*\p{L}/u)?.[1];
  if (initial && fromHandle.startsWith(initial)) return `${fromHandle} ${fromProfile}`;
  return fromProfile;
}

const REGION_WORD = /^(республик|област|обл$|край|края|район|р-н|округ|ао$)/i;

/**
 * City from a short answer to «из какого вы города?»: «Реутов Московская область» →
 * «Реутов», «Республика Крым, г. Симферополь» → «Симферополь», «Из Махачкалы» →
 * «Махачкала». A region alone («Республика Дагестан») gives ''.
 */
export function replyCity(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 80 || /https?:/i.test(t)) return '';
  const segments = t.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  // A segment marked «г.» / «город» is the city; otherwise the first one that is not a region.
  const marked = segments.find((x) => /(^|\s)(г\.|город\s)/i.test(x));
  for (const segment of marked ? [marked] : segments) {
    const words = segment.replace(/(^|\s)(г\.|город|из|в|с)(?=\s|$|\p{Lu})/giu, ' ').split(/\s+/).map((w) => w.replace(/[^\p{L}-]/gu, '')).filter(Boolean);
    if (!words.length || words.some((w) => REGION_WORD.test(w))) {
      const before = [];
      for (const w of words) { if (REGION_WORD.test(w)) break; before.push(w); }
      // «Реутов Московская область»: the town comes before the region's adjective.
      if (before.length >= 2) { const known = cityOf(before[0]); return known || title(before[0]); }
      continue;
    }
    const known = cityOf(words.join(' '));
    if (known) return known;
    if (words.length <= 2 && /^\p{Lu}/u.test(words[0]) && !REGIONS.has(words[0].toLocaleLowerCase('ru'))) return words.map(title).join(' ');
  }
  return '';
}

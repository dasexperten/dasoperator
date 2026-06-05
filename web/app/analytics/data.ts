// =============================================================================
// Analytics dataset — Ozon Performance API + WB Advert API, 30-day window
// Period: 2026-05-06 → 2026-06-05. Pulled live, aggregated per campaign / SKU.
// ДРР = ad spend / attributed revenue. CR = orders / clicks.
// =============================================================================

export const PERIOD = '6 мая — 5 июня 2026';
export const UPDATED = '5 июня 2026';

export type Platform = {
  key: 'ozon' | 'wb';
  name: string;
  spend: number;
  revenue: number;
  drr: number;
  orders: number;
  clicks: number;
  accent: string;
};

export const PLATFORMS: Record<'ozon' | 'wb', Platform> = {
  ozon: {
    key: 'ozon', name: 'Ozon', spend: 391762, revenue: 4575676,
    drr: 8.6, orders: 6486, clicks: 0, accent: '#0B7BC4',
  },
  wb: {
    key: 'wb', name: 'Wildberries', spend: 371741, revenue: 2478574,
    drr: 15.0, orders: 4527, clicks: 51276, accent: '#8A1FE5',
  },
};

// ---- OZON: campaign-level (only the 8 campaigns that actually spend) --------
export type Camp = { name: string; spend: number; drr: number; orders: number };
export const OZON_CAMPAIGNS: Camp[] = [
  { name: 'Трафареты Щётки',  spend: 92956, drr: 15.5, orders: 974 },
  { name: 'Трафареты Пасты',  spend: 71964, drr: 6.3,  orders: 1556 },
  { name: 'Спецпасты',        spend: 65772, drr: 7.1,  orders: 1162 },
  { name: 'Четвёрки ТОП',     spend: 64808, drr: 11.0, orders: 877 },
  { name: 'Паста ТОП',        spend: 61884, drr: 6.9,  orders: 1200 },
  { name: 'Нити / ёршики ТОП', spend: 20632, drr: 7.3, orders: 460 },
  { name: 'Поиск — все товары', spend: 8009, drr: 10.0, orders: 151 },
  { name: 'Детство',          spend: 4971,  drr: 11.3, orders: 81 },
];

// ---- WB: SKU-level (top by spend) -------------------------------------------
export type Sku = { name: string; spend: number; revenue: number; drr: number; cr: number; cpc: number; orders: number };
export const WB_SKUS: Sku[] = [
  { name: 'Щётка NANO MASSAGE силикон',     spend: 43695, revenue: 333323, drr: 13, cr: 5.8,  cpc: 5,  orders: 556 },
  { name: 'Чёрная отбел. паста (уголь)',     spend: 40410, revenue: 106737, drr: 38, cr: 9.8,  cpc: 14, orders: 277 },
  { name: 'Щётка MITTEL набор 4шт',          spend: 31936, revenue: 154780, drr: 21, cr: 5.7,  cpc: 7,  orders: 254 },
  { name: 'Щётка KINDER 3+ присоски',        spend: 29750, revenue: 49535,  drr: 60, cr: 9.5,  cpc: 12, orders: 229 },
  { name: 'Паста innoWeiss мультифермент',   spend: 27139, revenue: 231469, drr: 12, cr: 14.8, cpc: 13, orders: 314 },
  { name: 'Паста с про/пребиотиком',         spend: 25996, revenue: 242768, drr: 11, cr: 14.0, cpc: 10, orders: 382 },
  { name: 'Ёршики INTERDENTAL S 4шт',        spend: 23132, revenue: 154706, drr: 15, cr: 3.9,  cpc: 2,  orders: 427 },
  { name: 'Щётка AKTIV мягкая 4шт',          spend: 19683, revenue: 13957,  drr: 141, cr: 5.3, cpc: 43, orders: 24 },
  { name: 'Нить EXPANDING 100м',             spend: 19379, revenue: 181945, drr: 11, cr: 13.9, cpc: 9,  orders: 291 },
  { name: 'Щётка KRAFT flexineck набор',     spend: 17178, revenue: 125171, drr: 14, cr: 12.2, cpc: 9,  orders: 222 },
  { name: 'Паста натур. чувствит.',          spend: 12767, revenue: 142611, drr: 9,  cr: 11.2, cpc: 6,  orders: 229 },
  { name: 'Паста DETOX 70мл 2шт',            spend: 12250, revenue: 162043, drr: 8,  cr: 16.1, cpc: 8,  orders: 253 },
  { name: 'Щётка GROSSE 2шт',                spend: 9879,  revenue: 85765,  drr: 12, cr: 5.6,  cpc: 4,  orders: 139 },
  { name: 'Щётка SCHWARZ уголь мягкая',      spend: 9202,  revenue: 42282,  drr: 22, cr: 13.9, cpc: 18, orders: 70 },
  { name: 'Паста GINGER увлажняющая',        spend: 7895,  revenue: 20608,  drr: 38, cr: 5.4,  cpc: 8,  orders: 52 },
  { name: 'Нить SCHWARZ невощёная',          spend: 6810,  revenue: 36654,  drr: 19, cr: 11.8, cpc: 14, orders: 59 },
  { name: 'Паста гель имбирь-лимон',         spend: 6464,  revenue: 139656, drr: 5,  cr: 53.9, cpc: 15, orders: 228 },
  { name: 'Паста SYMBIOS пробиотик',         spend: 6115,  revenue: 46066,  drr: 13, cr: 25.9, cpc: 16, orders: 101 },
  { name: 'Паста SCHWARZ отбел. уголь',      spend: 5318,  revenue: 69110,  drr: 8,  cr: 20.4, cpc: 10, orders: 113 },
  { name: 'Щётка INTENSIV полировка',        spend: 3944,  revenue: 24118,  drr: 16, cr: 13.4, cpc: 8,  orders: 66 },
  { name: 'Скребок языка ZUNGER',            spend: 3777,  revenue: 12535,  drr: 30, cr: 4.1,  cpc: 5,  orders: 34 },
  { name: 'Щётки мягкие чувствит.',          spend: 2802,  revenue: 6748,   drr: 42, cr: 8.7,  cpc: 22, orders: 11 },
];

// ---- Curated insight lists (cross-platform), with concrete recommendation ---
export type Insight = { sku: string; plat: string; spend: number; drr: number; cr: number; note: string };

export const BLEEDERS: Insight[] = [
  { sku: 'Щётка AKTIV мягкая 4шт', plat: 'WB',   spend: 19683, drr: 141, cr: 5.3,  note: 'Тратим больше, чем продаём. CPC 43 ₽. Стоп.' },
  { sku: 'Щётка ZERO 360 (брекеты)', plat: 'Ozon', spend: 18324, drr: 90, cr: 1.5, note: 'ДРР 69–176% в двух кампаниях. Стоп до фикса карточки.' },
  { sku: 'Щётка KINDER 3+ присоски', plat: 'WB',  spend: 29750, drr: 60, cr: 9.5,  note: 'Реклама съедает 60% выручки. Срезать ставку вдвое.' },
  { sku: 'Чёрная отбел. паста (уголь)', plat: 'WB', spend: 40410, drr: 38, cr: 9.8, note: 'Самый дорогой SKU на WB при ДРР 38%. CPC 14 → 8.' },
  { sku: 'Щётка GROSSE 2шт', plat: 'Ozon', spend: 36357, drr: 12, cr: 4.2, note: '39% бюджета на щётки, конверсия вдвое ниже паст.' },
  { sku: 'Щётка MITTEL набор', plat: 'WB',  spend: 31936, drr: 21, cr: 5.7,  note: '3-й по расходу, слабая конверсия. Срезать ставку.' },
  { sku: 'Щётка SCHWARZ уголь', plat: 'Ozon+WB', spend: 26400, drr: 20, cr: 2.4, note: 'ДРР 18–23%. Чинить главное фото и цену.' },
  { sku: 'Паста GINGER увлажн.', plat: 'WB', spend: 7895, drr: 38, cr: 5.4, note: 'Единственная паста-аутсайдер. CPC 8, ставку вниз.' },
];

export const WINNERS: Insight[] = [
  { sku: 'Паста гель имбирь-лимон', plat: 'WB',   spend: 6464,  drr: 5,  cr: 53.9, note: 'CR 54%! Недоинвестируем. Поднять ставку ×2.' },
  { sku: 'Нить EXPANDING 100м', plat: 'Ozon+WB',  spend: 32989, drr: 8,  cr: 21,   note: 'ДРР 5,6–11%, CR до 28%. Масштабировать.' },
  { sku: 'Паста SYMBIOS пробиотик', plat: 'Ozon+WB', spend: 19009, drr: 9, cr: 24,  note: 'CR 22–26%, лучший ДРР среди паст. Лить больше.' },
  { sku: 'Паста с про/пребиотиком', plat: 'WB',   spend: 25996, drr: 11, cr: 14.0, note: 'Выручка 243 тыс при ДРР 11%. Запас по ставке.' },
  { sku: 'Паста DETOX', plat: 'Ozon+WB',          spend: 21994, drr: 6,  cr: 13,   note: 'ДРР 4–8%, стабильно. Увеличить охват.' },
  { sku: 'Паста innoWeiss', plat: 'WB',           spend: 27139, drr: 12, cr: 14.8, note: 'Высокий объём, здоровый ДРР. Держать и растить.' },
  { sku: 'Паста GINGER FORCE', plat: 'Ozon',      spend: 29361, drr: 5,  cr: 10,   note: '854 заказа, ДРР 4–6%. Флагман пастового спроса.' },
  { sku: 'Щётка KRAFT/KRAFTBÜRSTE', plat: 'Ozon+WB', spend: 19934, drr: 11, cr: 20, note: 'Единственная щётка с пастовой конверсией. Растить.' },
];

export const ACTIONS = [
  { title: 'Выключить хронически убыточные SKU', impact: '≈ 45 000 ₽/мес', tone: 'stop' as const,
    body: 'AKTIV (ДРР 141%), ZERO 360 (90%), KINDER 3+ (60%), BIO/MITTEL с CR < 1%. Возврат почти нулевой — снимаем сразу.' },
  { title: 'Срезать ставки на слабых щётках', impact: 'ДРР −2–3 п.п.', tone: 'cut' as const,
    body: 'GROSSE, SCHWARZ, ETALON, чёрная паста: ставки −30–40% и фикс главного фото / цены / остатка. Корень — конверсия, не CPC.' },
  { title: 'Перелить бюджет в победителей', impact: '+ выручка', tone: 'scale' as const,
    body: 'Освободившиеся ~70 тыс — в пасты и нити с ДРР 4–8% и CR 14–54%: имбирь-лимон, SYMBIOS, EXPANDING, DETOX, GINGER FORCE. Ставки ×1,5–2.' },
  { title: 'Починить ставки в «Поиске»', impact: 'CPC −40%', tone: 'cut' as const,
    body: 'Кампания «Поиск — все товары» на Ozon: CPC 43 ₽ при ДРР 10%. Снизить ставку до 20–25 ₽.' },
];

// =============================================================================
// Письма покупателю русской витрины dasexperten.ru — единственная дверь.
//
// Решение Владельца 27.08.2026: письмо пишет панель, конверт бросает магазин.
// Здесь живут тексты и их вид; отправляет витрина — у неё есть адрес покупателя,
// и он не уезжает из России (Владелец 21.08.2026, обезличенная выгрузка).
//
// Три письма — три отметки в CRM (LAW-20260827-02, буквы З · О · Д):
//   order        → zakaz@dasexperten.ru      заказ принят
//   payment      → oplata@dasexperten.ru     ждёт оплаты (кнопка) ИЛИ оплата получена
//   shipped      → dostavka@dasexperten.ru   заказ в пути
//
// Одно письмо про оплату, два лица: лицо выбирается в момент отправки по
// состоянию заказа. Заплатил — подтверждение без кнопки. Не заплатил — кнопка.
// Оба сразу не уходят никогда.
//
// Вид задан здесь и только здесь (Марика, CRAFT-20260826-01): письмо без
// html-части почтовый клиент рисует своим кеглем, и сумма рвётся посреди числа.
// Красить нечего — рабочее письмо читают один раз ради дела (LAW-20260804-01).
// Подпись собирается кодом из реестра, а не пишется в тексте (LAW-20260826-01),
// и обратный адрес в ней — тот ящик, от которого письмо ушло.
// =============================================================================

export type RuLetterKind = 'order' | 'payment' | 'shipped';

export interface RuLetterItem {
  name: string;
  qty: number;
  /** Цена за единицу в копейках. Ноль означает строку со скидкой 100%. */
  price_kop: number;
  total_kop: number;
}

export interface RuLetterOrder {
  public_number: string;
  customer_name?: string | null;
  items: RuLetterItem[];
  total_kop: number;
  delivery_kop?: number | null;
  /** Оплачен ли заказ на момент отправки — выбирает лицо письма про оплату. */
  paid?: boolean;
  paid_at?: string | null;
  payment_method?: string | null;
  /** Наша страница оплаты: она просит у банка свежую ссылку и не протухает. */
  pay_url?: string | null;
  created_at?: string | null;
  shipped_at?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  pickup_address?: string | null;
  eta_days?: number | null;
}

export interface RuLetter {
  kind: RuLetterKind;
  from: string;
  from_name: string;
  reply_to: string;
  subject: string;
  text: string;
  html: string;
}

const BOX: Record<RuLetterKind, string> = {
  order: 'zakaz@dasexperten.ru',
  payment: 'oplata@dasexperten.ru',
  shipped: 'dostavka@dasexperten.ru',
};

const FROM_NAME = 'Das Experten';
const SITE = 'dasexperten.ru';

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** «27 августа». Пустая строка, если даты нет — выдумывать её нечем. */
export function ruDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Копейки в рубли. Неразрывный пробел перед знаком: сумма не рвётся. */
export function money(kop: number): string {
  const v = Math.round(Number(kop) || 0) / 100;
  const s = v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${s}\u00a0₽`;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Приветствие. Имя на кассе не обязательно — обязателен телефон. Без имени
 * здороваемся просто, без пустого места и без «Здравствуйте, .»
 */
function hello(name?: string | null): string {
  const n = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  return n ? `Здравствуйте, ${n}.` : 'Здравствуйте.';
}

// ── одежда ───────────────────────────────────────────────────────────────────
// Шрифт системный намеренно: почта не загружает наши гарнитуры — этого не
// делает ни один клиент, — а Archivo вдобавок не знает кириллицы.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

function dress(inner: string, box: string): string {
  return [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light only">',
    '</head>',
    `<body style="margin:0;padding:0;background:#EDE9DF;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EDE9DF;">`,
    '<tr><td align="center" style="padding:24px 12px;">',
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:100%;max-width:560px;background:#FFFFFF;border-radius:10px;">`,
    `<tr><td style="padding:28px 28px 24px;font-family:${FONT};font-size:16px;line-height:1.5;color:#1A1519;">`,
    inner,
    `<div style="margin-top:26px;padding-top:16px;border-top:1px solid #E5E1D6;font-size:13px;line-height:1.6;color:#6B6862;">`,
    `${FROM_NAME}<br>${SITE}<br>Ответить: ${esc(box)}`,
    '</div>',
    '</td></tr></table>',
    '</td></tr></table></body></html>',
  ].join('');
}

/**
 * Имя строки для письма. Витрина приклеивает к названию пометку скидки
 * (gift_note), и справа в письме стоит она же — выходило «скидка 100%» дважды
 * в одной строке. Хвост срезаем; сама пометка остаётся в заказе и в чеке.
 */
function itemName(i: RuLetterItem): string {
  const n = String(i.name ?? '');
  return Number(i.total_kop) === 0 ? n.replace(/\s*[—-]\s*скидка[^—-]*$/i, '').trim() : n;
}

/** Товар слева, цена справа — одной верёвкой, цена не уезжает от своего товара. */
function itemRows(items: RuLetterItem[]): string {
  return items.map((i) => {
    const qty = Number(i.qty) || 1;
    const free = Number(i.total_kop) === 0;
    const right = free ? 'скидка 100%' : money(i.total_kop);
    const dim = free ? 'color:#6B6862;' : 'color:#1A1519;';
    return (
      `<tr><td style="padding:6px 0;${dim}">${esc(itemName(i))}${qty > 1 ? ` · ${qty} шт` : ''}</td>` +
      `<td style="padding:6px 0;text-align:right;white-space:nowrap;${dim}">${right}</td></tr>`
    );
  }).join('');
}

function itemLines(items: RuLetterItem[]): string {
  return items.map((i) => {
    const qty = Number(i.qty) || 1;
    const right = Number(i.total_kop) === 0 ? 'скидка 100%' : money(i.total_kop);
    return `${itemName(i)}${qty > 1 ? ` · ${qty} шт` : ''} — ${right}`;
  }).join('\n');
}

function table(inner: string, totalLabel: string, totalKop: number): string {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">' +
    inner +
    `<tr><td style="padding:12px 0 0;border-top:1px solid #E5E1D6;font-weight:600;">${totalLabel}</td>` +
    `<td style="padding:12px 0 0;border-top:1px solid #E5E1D6;text-align:right;white-space:nowrap;font-weight:600;">${money(totalKop)}</td></tr>` +
    '</table>'
  );
}

function button(href: string, label: string): string {
  return (
    `<div style="margin:24px 0;"><a href="${esc(href)}" ` +
    'style="display:block;background:#1A1519;color:#FFFFFF;text-align:center;padding:15px 0;' +
    `border-radius:8px;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:600;">` +
    `${esc(label)}</a></div>`
  );
}

function plate(label: string, value: string): string {
  return (
    '<div style="background:#F3F0E8;border-radius:8px;padding:14px 16px;margin:0 0 18px;">' +
    `<div style="font-size:13px;color:#6B6862;">${esc(label)}</div>` +
    `<div style="font-size:16px;font-weight:600;color:#1A1519;margin-top:2px;word-break:break-all;">${esc(value)}</div>` +
    '</div>'
  );
}

function p(s: string, style = ''): string {
  return `<p style="margin:0 0 16px;${style}">${s}</p>`;
}

const fine = 'font-size:13px;color:#6B6862;line-height:1.5;';

// ── письма ───────────────────────────────────────────────────────────────────

export function renderRuLetter(kind: RuLetterKind, o: RuLetterOrder): RuLetter {
  const num = o.public_number;
  const box = BOX[kind];
  const greet = hello(o.customer_name);
  const items = Array.isArray(o.items) ? o.items : [];
  let subject = '';
  let inner = '';
  let text = '';

  if (kind === 'order') {
    const when = ruDate(o.created_at);
    subject = `Заказ ${num} принят`;
    inner =
      p(greet) +
      p('Мы получили ваш заказ и держим товар за вами.') +
      `<p style="margin:0 0 12px;${fine}">Заказ ${esc(num)}${when ? ` от ${when}` : ''}</p>` +
      table(itemRows(items), 'Итого', o.total_kop) +
      `<p style="margin:10px 0 0;${fine}">Доставка по России бесплатная.</p>` +
      `<p style="margin:18px 0 0;">Письмо об оплате придёт отдельно.</p>`;
    text = [
      greet, '',
      'Мы получили ваш заказ и держим товар за вами.', '',
      `Заказ ${num}${when ? ` от ${when}` : ''}`, '',
      itemLines(items), '',
      `Итого ${money(o.total_kop)}`,
      'Доставка по России бесплатная.', '',
      'Письмо об оплате придёт отдельно.',
    ].join('\n');
  } else if (kind === 'payment' && !o.paid) {
    subject = `Заказ ${num} ждёт оплаты`;
    inner =
      p(greet) +
      p('Заказ собран и ждёт оплаты. Товар держим за вами.') +
      table(itemRows(items), 'К оплате', o.total_kop) +
      (o.pay_url ? button(o.pay_url, `Оплатить ${money(o.total_kop)}`) : '') +
      `<p style="margin:0;${fine}">Не получилось оплатить — ответьте на это письмо, поможем.</p>`;
    text = [
      greet, '',
      'Заказ собран и ждёт оплаты. Товар держим за вами.', '',
      itemLines(items), '',
      `К оплате ${money(o.total_kop)}`,
      ...(o.pay_url ? ['', `Оплатить: ${o.pay_url}`] : []), '',
      'Не получилось оплатить — ответьте на это письмо, поможем.',
    ].join('\n');
  } else if (kind === 'payment') {
    const when = ruDate(o.paid_at);
    const how = o.payment_method === 'card' ? ', картой' : '';
    subject = `Оплата по заказу ${num} получена`;
    inner =
      p(greet) +
      p(`Деньги пришли — <span style="font-weight:600;white-space:nowrap;">${money(o.total_kop)}</span>${how}${when ? `, ${when}` : ''}.`) +
      plate(`Заказ ${num}`, 'Оплачен') +
      p('Соберём в течение рабочего дня. Письмо с номером отслеживания придёт, как передадим в доставку.') +
      `<p style="margin:0;${fine}">Кассовый чек придёт отдельным письмом от банка — так требует закон, и мы его не дублируем.</p>`;
    text = [
      greet, '',
      `Деньги пришли — ${money(o.total_kop)}${how}${when ? `, ${when}` : ''}.`, '',
      `Заказ ${num} оплачен.`, '',
      'Соберём в течение рабочего дня. Письмо с номером отслеживания придёт, как передадим в доставку.', '',
      'Кассовый чек придёт отдельным письмом от банка — так требует закон, и мы его не дублируем.',
    ].join('\n');
  } else {
    const when = ruDate(o.shipped_at);
    const track = String(o.tracking_number ?? '').trim();
    subject = `Заказ ${num} в пути`;
    inner =
      p(greet) +
      p(`Заказ уехал${when ? ` ${when}` : ''}.`) +
      (track ? plate('Номер для отслеживания', track) : '') +
      (o.tracking_url ? button(o.tracking_url, 'Где посылка') : '') +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">' +
      (o.pickup_address
        ? `<tr><td style="padding:5px 0;${fine}width:96px;vertical-align:top;">Забрать</td><td style="padding:5px 0;">${esc(o.pickup_address)}</td></tr>`
        : '') +
      (o.eta_days
        ? `<tr><td style="padding:5px 0;${fine}vertical-align:top;">Срок</td><td style="padding:5px 0;">${Number(o.eta_days)} дн.</td></tr>`
        : '') +
      '</table>' +
      `<p style="margin:16px 0 0;${fine}">Пункт пришлёт сообщение, когда посылка будет готова к выдаче. Задержится или придёт повреждённой — ответьте на это письмо, разберёмся.</p>`;
    text = [
      greet, '',
      `Заказ уехал${when ? ` ${when}` : ''}.`, '',
      ...(track ? [`Номер для отслеживания: ${track}`] : []),
      ...(o.tracking_url ? [`Где посылка: ${o.tracking_url}`] : []),
      ...(o.pickup_address ? [`Забрать: ${o.pickup_address}`] : []),
      ...(o.eta_days ? [`Срок: ${Number(o.eta_days)} дн.`] : []), '',
      'Пункт пришлёт сообщение, когда посылка будет готова к выдаче.',
      'Задержится или придёт повреждённой — ответьте на это письмо, разберёмся.',
    ].join('\n');
  }

  return {
    kind,
    from: box,
    from_name: FROM_NAME,
    reply_to: box,
    subject,
    text: `${text}\n\n${FROM_NAME}\n${SITE}\nОтветить: ${box}`,
    html: dress(inner, box),
  };
}

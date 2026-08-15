// =============================================================================
// Website order emails (Phase 12.1)
//
// Fired from the order ingest path so every paid .com order triggers them
// exactly once (guarded by upsertOrder's action==='created', so the webhook +
// hourly poller never double-send):
//
//   • Internal notification → orders@dasexperten.com
//       (a Cloudflare Email Routing address forwarding to the merchant inbox).
//   • Customer confirmation / tracking → the buyer.
//
// Both go through the unrestricted EMAIL binding (Cloudflare Email Sending) from
// the branded sender orders@notify.dasexperten.com, Reply-To orders@dasexperten.com.
// That domain has SPF/DKIM configured and `orders@` is one of its intended
// senders (see api/wrangler.toml [[send_email]] + services/email.ts SENDERS).
// NO .de domain is used (owner decision).
//
// All sends are best-effort: an email failure must never break order ingest.
// =============================================================================

import type { Env } from '../types';
import { sendEmail, SENDERS } from '../services/email';

export const ORDERS_INBOX = 'orders@dasexperten.com';
// The buyer replies to a human mailbox; ORDERS_INBOX is where automation
// notifications land and nobody answers customers there.
const REPLY_TO = 'support@dasexperten.com';

export interface OrderEmailData {
  order_number: string;
  email?: string | null;
  customer_name?: string | null;
  currency?: string | null;
  total_cents?: number | null;
  subtotal_cents?: number | null;
  shipping_cents?: number | null;
  lang?: string | null;
  ship_country?: string | null;
  ship_city?: string | null;
  items?: Array<{ sku: string; name?: string | null; qty: number }> | null;
  placed_at?: number | null;
}

type Lang = 'en' | 'de' | 'ru' | 'vi';

function pickLang(lang?: string | null): Lang {
  const l = String(lang ?? '').slice(0, 2).toLowerCase();
  return l === 'de' || l === 'ru' || l === 'vi' ? (l as Lang) : 'en';
}

function money(cents: number | null | undefined, currency: string | null | undefined): string {
  const c = Number(cents ?? 0);
  const cur = (currency ?? 'USD').toUpperCase();
  // JPY-style zero-decimal currencies aside, cents/100 is right for the
  // storefront's presentment set; this string is display-only.
  return `${(c / 100).toFixed(2)} ${cur}`;
}

// "AM" reads like a system glitch to a buyer. Intl carries full ICU data in
// Workers, so the region name comes out correct in every locale we ship copy
// for; an unknown code degrades to the code itself rather than throwing.
function countryName(code: string | null | undefined, lang: Lang): string {
  const c = String(code ?? '').trim().toUpperCase();
  if (c.length !== 2) return c;
  try {
    const dn = new Intl.DisplayNames([lang], { type: 'region' });
    return dn.of(c) ?? c;
  } catch {
    return c;
  }
}

function orderDate(ts: number | null | undefined, lang: Lang): string {
  const seconds = Number(ts ?? 0);
  const d = seconds > 0 ? new Date(seconds * 1000) : new Date();
  try {
    return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function itemsLines(o: OrderEmailData): string {
  return (o.items ?? [])
    .map((it) => `  • ${it.name ?? it.sku} × ${it.qty}`)
    .join('\n');
}

function itemsRows(o: OrderEmailData): string {
  return (o.items ?? [])
    .map((it) => `<tr><td>${escapeHtml(it.name ?? it.sku)}</td><td style="text-align:right">× ${it.qty}</td></tr>`)
    .join('');
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;'
  );
}

// ---------------------------------------------------------------------------
// Customer-facing copy (localized). Kept compact; the .com storefront links
// only — never a .de domain.
// ---------------------------------------------------------------------------
const T = {
  confirmSubject: {
    en: (n: string) => `Your Das Experten order ${n} is confirmed`,
    de: (n: string) => `Deine Das Experten Bestellung ${n} ist bestätigt`,
    ru: (n: string) => `Ваш заказ Das Experten ${n} подтверждён`,
    vi: (n: string) => `Đơn hàng Das Experten ${n} của bạn đã được xác nhận`,
  },
  confirmIntro: {
    en: 'Thank you for your order! We have received your payment and your order is being prepared for shipment.',
    de: 'Vielen Dank für deine Bestellung! Wir haben deine Zahlung erhalten und bereiten den Versand vor.',
    ru: 'Спасибо за заказ! Мы получили оплату и готовим отправку.',
    vi: 'Cảm ơn bạn đã đặt hàng! Chúng tôi đã nhận được thanh toán và đang chuẩn bị giao hàng.',
  },
  orderLbl: { en: 'Order', de: 'Bestellung', ru: 'Заказ', vi: 'Đơn hàng' },
  totalLbl: { en: 'Total', de: 'Gesamt', ru: 'Итого', vi: 'Tổng cộng' },
  itemsLbl: { en: 'Items', de: 'Artikel', ru: 'Товары', vi: 'Sản phẩm' },
  shipToLbl: { en: 'Ship to', de: 'Lieferung an', ru: 'Адрес доставки', vi: 'Giao đến' },
  subtotalLbl: { en: 'Goods', de: 'Waren', ru: 'Сумма товаров', vi: 'Hàng hóa' },
  shippingLbl: { en: 'Shipping', de: 'Versand', ru: 'Доставка', vi: 'Phí giao hàng' },
  freeShip: { en: 'free', de: 'kostenlos', ru: 'бесплатно', vi: 'miễn phí' },
  dateLbl: { en: 'Order date', de: 'Bestelldatum', ru: 'Дата заказа', vi: 'Ngày đặt hàng' },
  helpLine: {
    en: 'Questions about this order? Just reply to this email — we answer every one.',
    de: 'Fragen zu dieser Bestellung? Antworte einfach auf diese E-Mail — wir antworten auf jede.',
    ru: 'Есть вопрос по заказу? Просто ответьте на это письмо — мы отвечаем на каждое.',
    vi: 'Có câu hỏi về đơn hàng? Chỉ cần trả lời email này — chúng tôi trả lời mọi thư.',
  },
  signoff: { en: 'Das Experten', de: 'Das Experten', ru: 'Das Experten', vi: 'Das Experten' },
  trackSubject: {
    en: (n: string) => `Your Das Experten order ${n} has shipped`,
    de: (n: string) => `Deine Das Experten Bestellung ${n} wurde versandt`,
    ru: (n: string) => `Ваш заказ Das Experten ${n} отправлен`,
    vi: (n: string) => `Đơn hàng Das Experten ${n} đã được gửi đi`,
  },
  trackIntro: {
    en: 'Good news — your order is on its way. You can track it with the link below.',
    de: 'Gute Nachrichten — deine Bestellung ist unterwegs. Verfolge sie über den Link unten.',
    ru: 'Хорошие новости — заказ уже в пути. Отследить можно по ссылке ниже.',
    vi: 'Tin vui — đơn hàng của bạn đang trên đường giao. Theo dõi qua liên kết bên dưới.',
  },
  trackLbl: { en: 'Track your parcel', de: 'Sendung verfolgen', ru: 'Отследить посылку', vi: 'Theo dõi đơn hàng' },
  trackNoLbl: { en: 'Tracking number', de: 'Sendungsnummer', ru: 'Трек-номер', vi: 'Mã vận đơn' },
  packedSubject: {
    en: (n: string) => `Your Das Experten order ${n} is packed`,
    de: (n: string) => `Deine Das Experten Bestellung ${n} ist verpackt`,
    ru: (n: string) => `Ваш заказ Das Experten ${n} собран`,
    vi: (n: string) => `Đơn hàng Das Experten ${n} đã được đóng gói`,
  },
  packedIntro: {
    en: 'Your order is packed and booked with the carrier. It leaves our warehouse within one working day, and this tracking number starts moving as soon as it does.',
    de: 'Deine Bestellung ist verpackt und beim Versanddienstleister angemeldet. Sie verlässt unser Lager innerhalb eines Werktags — dann beginnt sich diese Sendungsnummer zu bewegen.',
    ru: 'Заказ собран и передан перевозчику. Он покинет наш склад в течение одного рабочего дня — с этого момента трек-номер начнёт обновляться.',
    vi: 'Đơn hàng của bạn đã được đóng gói và bàn giao cho đơn vị vận chuyển. Hàng rời kho trong vòng một ngày làm việc, và mã vận đơn sẽ bắt đầu cập nhật từ lúc đó.',
  },
  packedNote: {
    en: 'No action is needed from you — we write again the moment it ships.',
    de: 'Du musst nichts tun — wir melden uns wieder, sobald die Sendung unterwegs ist.',
    ru: 'От вас ничего не требуется — мы напишем снова, как только посылка поедет.',
    vi: 'Bạn không cần làm gì thêm — chúng tôi sẽ báo lại ngay khi hàng được gửi đi.',
  },
} as const;

// ---------------------------------------------------------------------------
// New paid order — internal notification + customer confirmation.
// ---------------------------------------------------------------------------
export async function sendNewOrderEmails(env: Env, o: OrderEmailData): Promise<void> {
  const total = money(o.total_cents, o.currency);
  const shipTo = [o.ship_city, o.ship_country].filter(Boolean).join(', ');

  // 1) Internal → orders@dasexperten.com
  const internalText =
    `New paid order on dasexperten.com\n\n` +
    `Order: ${o.order_number}\n` +
    `Customer: ${o.customer_name ?? '—'} <${o.email ?? '—'}>\n` +
    `Ship to: ${shipTo || '—'}\n` +
    `Total: ${total}\n\n` +
    `Items:\n${itemsLines(o) || '  —'}`;
  await sendEmail(env, {
    to: ORDERS_INBOX,
    from: SENDERS.orders,
    subject: `New order ${o.order_number} — ${total}`,
    text: internalText,
    html:
      `<h2>New paid order on dasexperten.com</h2>` +
      `<p><strong>Order:</strong> ${escapeHtml(o.order_number)}<br>` +
      `<strong>Customer:</strong> ${escapeHtml(o.customer_name ?? '—')} &lt;${escapeHtml(o.email ?? '—')}&gt;<br>` +
      `<strong>Ship to:</strong> ${escapeHtml(shipTo || '—')}<br>` +
      `<strong>Total:</strong> ${escapeHtml(total)}</p>` +
      `<table style="border-collapse:collapse"><tbody>${itemsRows(o)}</tbody></table>`,
  });

  // 2) Customer confirmation — only if we have an address
  if (o.email) {
    const lang = pickLang(o.lang);
    const placed = orderDate(o.placed_at, lang);
    // Goods and shipping shown separately — a single total is the first thing
    // customers write in about. Falls back to the total when the split is absent.
    const goods = money(o.subtotal_cents ?? o.total_cents, o.currency);
    const shipCents = Number(o.shipping_cents ?? 0);
    const ship = shipCents > 0 ? money(shipCents, o.currency) : T.freeShip[lang];
    const shipLine = [o.ship_city, countryName(o.ship_country, lang)].filter(Boolean).join(', ');
    await sendEmail(env, {
      to: o.email,
      from: SENDERS.orders,
      replyTo: REPLY_TO,
      subject: T.confirmSubject[lang](o.order_number),
      text:
        `${T.confirmIntro[lang]}\n\n` +
        `${T.orderLbl[lang]}: ${o.order_number}\n` +
        `${T.dateLbl[lang]}: ${placed}\n\n` +
        `${T.itemsLbl[lang]}:\n${itemsLines(o) || '  —'}\n\n` +
        `${T.subtotalLbl[lang]}: ${goods}\n` +
        `${T.shippingLbl[lang]}: ${ship}\n` +
        `${T.totalLbl[lang]}: ${total}\n` +
        (shipLine ? `\n${T.shipToLbl[lang]}: ${shipLine}\n` : '') +
        `\n${T.helpLine[lang]}\n` +
        `\n${T.signoff[lang]}\nhttps://dasexperten.com`,
      html:
        `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;color:#1a1a1a">` +
        `<p>${escapeHtml(T.confirmIntro[lang])}</p>` +
        `<p><strong>${escapeHtml(T.orderLbl[lang])}:</strong> ${escapeHtml(o.order_number)}<br>` +
        `<strong>${escapeHtml(T.dateLbl[lang])}:</strong> ${escapeHtml(placed)}</p>` +
        `<table style="width:100%;border-collapse:collapse"><tbody>${itemsRows(o)}</tbody></table>` +
        `<table style="width:100%;border-collapse:collapse;margin-top:12px">` +
        `<tbody>` +
        `<tr><td>${escapeHtml(T.subtotalLbl[lang])}</td>` +
        `<td style="text-align:right">${escapeHtml(goods)}</td></tr>` +
        `<tr><td>${escapeHtml(T.shippingLbl[lang])}</td>` +
        `<td style="text-align:right">${escapeHtml(ship)}</td></tr>` +
        `<tr><td style="padding-top:6px;border-top:1px solid #ddd"><strong>${escapeHtml(T.totalLbl[lang])}</strong></td>` +
        `<td style="padding-top:6px;border-top:1px solid #ddd;text-align:right"><strong>${escapeHtml(total)}</strong></td></tr>` +
        `</tbody></table>` +
        (shipLine ? `<p><strong>${escapeHtml(T.shipToLbl[lang])}:</strong> ${escapeHtml(shipLine)}</p>` : '') +
        `<p style="margin-top:20px;color:#555">${escapeHtml(T.helpLine[lang])}</p>` +
        `<p style="margin-top:24px">${escapeHtml(T.signoff[lang])}<br>` +
        `<a href="https://dasexperten.com">dasexperten.com</a></p></div>`,
    });
  }
}

// ---------------------------------------------------------------------------
// Order shipped — customer tracking email + internal copy.
// ---------------------------------------------------------------------------
export async function sendTrackingEmails(
  env: Env,
  o: OrderEmailData,
  tracking: { tracking_number?: string | null; tracking_url?: string | null; carrier?: string | null }
): Promise<void> {
  const num = tracking.tracking_number ?? '';
  const url = tracking.tracking_url ?? '';

  // Internal copy → orders@
  await sendEmail(env, {
    to: ORDERS_INBOX,
    from: SENDERS.orders,
    subject: `Order ${o.order_number} shipped`,
    text:
      `Order ${o.order_number} shipped` +
      (tracking.carrier ? ` via ${tracking.carrier}` : '') +
      `.\nTracking: ${num || '—'}\n${url || ''}`,
  });

  if (!o.email) return;
  const lang = pickLang(o.lang);
  const trackLine = url
    ? `${T.trackLbl[lang]}: ${url}\n`
    : num
      ? `${T.trackNoLbl[lang]}: ${num}\n`
      : '';
  const linkHtml = url
    ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(T.trackLbl[lang])}</a></p>`
    : '';
  await sendEmail(env, {
    to: o.email,
    from: SENDERS.orders,
    replyTo: REPLY_TO,
    subject: T.trackSubject[lang](o.order_number),
    text:
      `${T.trackIntro[lang]}\n\n` +
      `${T.orderLbl[lang]}: ${o.order_number}\n` +
      (num ? `${T.trackNoLbl[lang]}: ${num}\n` : '') +
      trackLine +
      `\n${T.signoff[lang]}\nhttps://dasexperten.com`,
    html:
      `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px">` +
      `<p>${escapeHtml(T.trackIntro[lang])}</p>` +
      `<p><strong>${escapeHtml(T.orderLbl[lang])}:</strong> ${escapeHtml(o.order_number)}</p>` +
      (num ? `<p><strong>${escapeHtml(T.trackNoLbl[lang])}:</strong> ${escapeHtml(num)}</p>` : '') +
      linkHtml +
      `<p style="margin-top:24px">${escapeHtml(T.signoff[lang])}<br>` +
      `<a href="https://dasexperten.com">dasexperten.com</a></p></div>`,
  });
}


// ---------------------------------------------------------------------------
// Order packed — the parcel exists, the carrier has it, nothing moves yet.
//
// Owner 2026-08-15: this notice is automatic and it speaks as delivery@.
// It fires once per order, guarded upstream by crm_orders.packed_notified_at,
// on the NSS transition into 'scheduled'. No internal copy: orders@ already
// heard about this order at payment, and a second inbox ping per parcel is
// noise, not information.
// ---------------------------------------------------------------------------
export async function sendPackedEmails(
  env: Env,
  o: OrderEmailData,
  tracking: { tracking_number?: string | null; tracking_url?: string | null; carrier?: string | null }
): Promise<void> {
  if (!o.email) return;
  const lang = pickLang(o.lang);
  const num = tracking.tracking_number ?? '';
  const url = tracking.tracking_url ?? '';
  const shipLine = [o.ship_city, countryName(o.ship_country, lang)].filter(Boolean).join(', ');
  const linkHtml = url
    ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(T.trackLbl[lang])}</a></p>`
    : '';
  await sendEmail(env, {
    to: o.email,
    from: SENDERS.delivery,
    replyTo: REPLY_TO,
    subject: T.packedSubject[lang](o.order_number),
    text:
      `${T.packedIntro[lang]}\n\n` +
      `${T.orderLbl[lang]}: ${o.order_number}\n` +
      (num ? `${T.trackNoLbl[lang]}: ${num}\n` : '') +
      (url ? `${T.trackLbl[lang]}: ${url}\n` : '') +
      (shipLine ? `${T.shipToLbl[lang]}: ${shipLine}\n` : '') +
      `\n${T.packedNote[lang]}\n` +
      `\n${T.signoff[lang]}\nhttps://dasexperten.com`,
    html:
      `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;color:#1a1a1a">` +
      `<p>${escapeHtml(T.packedIntro[lang])}</p>` +
      `<p><strong>${escapeHtml(T.orderLbl[lang])}:</strong> ${escapeHtml(o.order_number)}` +
      (num ? `<br><strong>${escapeHtml(T.trackNoLbl[lang])}:</strong> ${escapeHtml(num)}` : '') +
      (shipLine ? `<br><strong>${escapeHtml(T.shipToLbl[lang])}:</strong> ${escapeHtml(shipLine)}` : '') +
      `</p>` +
      linkHtml +
      `<p style="margin-top:20px;color:#555">${escapeHtml(T.packedNote[lang])}</p>` +
      `<p style="margin-top:24px">${escapeHtml(T.signoff[lang])}<br>` +
      `<a href="https://dasexperten.com">dasexperten.com</a></p></div>`,
  });
}

// ---------------------------------------------------------------------------
// Tracking links — built here, not taken on trust from the fulfiller.
//
// 2026-08-19: NextSmartShip handed us a DHL *Express* link for a parcel moving
// as a regular DHL Paket. Express tracks 10-digit air waybills; the parcel had
// a 20-digit Deutsche Post piece code, so the buyer's link opened DHL's "sorry,
// this page is unavailable" screen. Carrier and number were both correct in
// our own record — only the URL was wrong, and we were reprinting it verbatim.
//
// Scope is deliberately narrow. We override ONLY where we know the fulfiller's
// pattern is wrong (the DHL split). For every other carrier the fulfiller's own
// link is still the best source, because it is the one their support desk sees.
// When there is no link at all, a universal tracker beats a bare number.
//
// Adding a carrier: add a case, and only after opening the built URL by hand
// with a real number. A guessed URL is worse than no link — it looks official
// and goes nowhere, which is exactly the failure this file exists to stop.
// ---------------------------------------------------------------------------

/** Deutsche Post / DHL Paket piece code: 12-20 digits, in practice 20 starting 00. */
function isParcelPieceCode(n: string): boolean {
  return /^\d{12,20}$/.test(n) && n.length >= 16;
}

/** DHL Express air waybill: 10 digits. */
function isExpressAwb(n: string): boolean {
  return /^\d{10}$/.test(n);
}

/**
 * Returns the link to put in front of the buyer.
 *
 * @param carrier  carrier name as recorded on the order (e.g. "DHL Paket")
 * @param number   tracking number as recorded on the order
 * @param given    the link the fulfiller supplied, if any
 */
export function trackingLink(
  carrier?: string | null,
  number?: string | null,
  given?: string | null
): string | null {
  const num = String(number ?? '').trim();
  const name = String(carrier ?? '').trim().toLowerCase();
  const fallback = given && /^https?:\/\//i.test(given) ? given : null;

  if (!num) return fallback;

  // --- DHL: the whole reason this module exists ---------------------------
  if (name.includes('dhl') || name.includes('deutsche post')) {
    const saysExpress = name.includes('express');
    // The number decides, not the label: fulfillers mislabel the service far
    // more often than they mistype a barcode.
    if (isExpressAwb(num)) {
      return `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(num)}`;
    }
    if (isParcelPieceCode(num)) {
      return `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${encodeURIComponent(num)}`;
    }
    if (saysExpress) {
      return `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(num)}`;
    }
    return fallback ?? universal(num);
  }

  // --- Everyone else: the fulfiller's own link wins ------------------------
  return fallback ?? universal(num);
}

/** Multi-carrier tracker — used only when nobody gave us a link at all. */
function universal(num: string): string {
  return `https://t.17track.net/en#nums=${encodeURIComponent(num)}`;
}

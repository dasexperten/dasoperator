// Moscow has a fixed UTC+3 offset. Slots name the date on which they start.
export function dianaWorkWindow(timestamp = Date.now()) {
  const local = new Date(timestamp + 3 * 60 * 60 * 1000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const date = local.toISOString().slice(0, 10);
  const slot = minute < 30 ? 'night' : minute >= 360 && minute < 390 ? 'morning' : null;
  // Owner 2026-11-12: «Direct answers 06:00–02:00» Yerevan (UTC+4) = 05:00–01:00 Moscow.
  return { direct: minute >= 300 || minute < 60, round: slot, date };
}

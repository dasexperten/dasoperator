// Moscow has a fixed UTC+3 offset. Slots name the date on which they start.
export function dianaWorkWindow(timestamp = Date.now()) {
  const local = new Date(timestamp + 3 * 60 * 60 * 1000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const date = local.toISOString().slice(0, 10);
  const slot = minute < 30 ? 'night' : minute >= 360 && minute < 390 ? 'morning' : null;
  return { direct: minute >= 480 && minute < 1410, round: slot, date };
}

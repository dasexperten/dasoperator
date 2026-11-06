// Retired by Owner 2026-11-06. ERP detects metadata; Diana alone reads and replies.
// Compatibility export prevents an old internal caller from generating or sending text.
export const DIANA_ALARM = 'diana_alarm';
export const DIANA_ALARM_KEY = (cid: string) => `diana_round_alarm:${cid}`;
export async function igDmReply(_env: unknown) {
  return { replied: 0, escalated: 0, errors: 0, alarm_only: true };
}

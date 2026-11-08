export const NAME = 'erp-order-vn';
export const PREFIX = `${NAME}:`;
export function dayKey(now = new Date()) {
  return PREFIX + new Date(now.getTime() + 4 * 3600000).toISOString().slice(0, 10);
}
export function signal(now = new Date()) {
  return { name: NAME, target: 'tet', finance: 'justina-timber', state: 'pending',
    day: dayKey(now).slice(PREFIX.length), requested_at: now.toISOString() };
}
export function validEvidence(body) {
  return body && typeof body.note === 'string' && body.note.trim().length > 0
    && Array.isArray(body.evidence) && body.evidence.length > 0
    && body.evidence.every(x => typeof x === 'string' && x.trim().length > 0);
}

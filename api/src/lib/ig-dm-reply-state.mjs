// A failed Direct step is pending work, never a handled incoming message.
const TECHNICAL = new Set(['unparsable', 'too long', 'promises payment', 'claims money sent, not paid in ERP', 'menu jargon in a reply', 'says face is optional', 'offers unboxing or closed packaging', 'surname initial not written', 'ozon article needed', 'foreign ozon article', 'confirms unseen photo', 'refusal tone', 'scenario before order', 'off voice', 'voice_check_unavailable', 'scenario outside active menu', 'provider_error', 'image_read_failed', 'payout_registration_failed', 'creator_registration_failed', 'conversation_check_failed', 'send_failed',
  // Rewrites the model can fix on the next attempt (guard rules of 2026-10-17); a paid request stays with a person.
  'offers a brush, paste only', 'claim about children', 'adult wording', 'warm address too early, keep it neutral', 'informal ты, always вы', 'ask for the order screenshot too', 'one person, one program; ask what she means', 'do not repeat phone and recipient to the blogger', 'command tone, ask with «пожалуйста»', 'paid notice as a question, use «Перевела N ₽ по СБП. Проверьте, пожалуйста, должно быть уже дошло.»',
  'vision_error', 'image_unreadable_text_error', 'diana_context_unavailable', 'diana_image_check_unavailable', 'diana_context_audit_failed', 'image_verdict_requires_clarification',
  'current_image_unavailable', 'current_attachment_metadata_unavailable', 'diana_image_decode_unavailable']);
export const isTechnical = (reason) => TECHNICAL.has(String(reason ?? '').split(':')[0].trim());
export const RETRY_DELAY_MS = 5 * 60_000;
export const MAX_REPLY_ATTEMPTS = 3;
export const HOURLY_RETRY_MS = 60 * 60_000;
export const HOURLY_RETRY_WINDOW_MS = 24 * 3_600_000;

export function readReplyState(value) {
  try { const s = typeof value === 'string' ? JSON.parse(value) : value; return s && typeof s.at === 'string' ? s : null; } catch { return null; }
}
export function canAttemptReply(state, at, now = Date.now()) {
  if (!state || state.at !== at) return true;
  return state.status === 'retry' && Number(state.next_retry_at ?? 0) <= now;
}
export function nextReplyFailure(previous, { at, handle, reason, now = Date.now() }) {
  const attempts = previous?.at === at ? Number(previous.attempts ?? 0) + 1 : 1;
  const kind = isTechnical(reason) ? 'technical' : 'business';
  // Owner 2026-10-18 (khanbabaevaselmaia): a technical failure is never dropped after three
  // quick tries. Then the server comes back every hour for a day; only after that a person looks.
  const sinceAt = now - (Date.parse(at) || now);
  const quick = attempts < MAX_REPLY_ATTEMPTS;
  const hourly = !quick && sinceAt < HOURLY_RETRY_WINDOW_MS;
  return { handle, at, reason: String(reason || 'Требуется ручная проверка').replace(/(?:\+?7|8)[\s\d()\-]{9,18}/g, '[телефон]').slice(0, 200), kind, attempts,
    status: kind === 'technical' && (quick || hourly) ? 'retry' : 'needs_review',
    next_retry_at: now + (quick ? RETRY_DELAY_MS : HOURLY_RETRY_MS),
    notified_at: previous?.at === at ? previous.notified_at ?? null : null };
}
export function replyAttention(state) {
  // Owner 2026-10-18: a photo programs cannot open is shown to the Owner first.
  if (state.reason === 'photo_for_owner') return { at: state.at, status: 'retry', kind: 'business', code: 'photo_for_owner',
    label: 'Посмотрите фото', reason: 'Фото не открывается в ERP. Посмотрите его в переписке в приложении и напишите здесь, что на нём. Без вас через 30 минут Диана мягко попросит прислать его ещё раз.' };
  const technical = state.kind === 'technical' || isTechnical(state.reason);
  return { at: state.at, code: state.reason, status: state.status === 'retry' ? 'retry' : 'needs_review',
    kind: technical ? 'technical' : 'business',
    label: state.status === 'retry' ? 'Повторная обработка' : 'Требует проверки',
    reason: state.reason === 'image_read_failed' ? 'Скриншот не удалось прочитать; обращение остаётся в работе.' : technical ? 'Автоответ не завершён; обращение остаётся в работе.' : 'Обращение передано на ручную проверку; требуется решение по переписке.' };
}

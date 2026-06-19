// Internal email-type classifier — NOT shown on the frontend. Tags each email with an
// email_type used by the two-layer rules engine (Forward/Delete write sender×type rules)
// and by triage. Heuristic first, cheap LLM fallback for the ambiguous middle.
import type { Env } from '../types';

// First group routes to the inbox (attention); second group are exclude candidates.
export const EMAIL_TYPES = [
  'order_issue', 'payment', 'invoice', 'contract', 'partner_inquiry', 'marketplace_news', 'support_question',
  'marketplace_acceptance', 'promo', 'newsletter', 'otp_transactional', 'our_outbound', 'cold_spam',
] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

const OURS = /(dasexperten@gmail|@dasexperten\.(de|ru)|eurasia@|export@|emea@|support@)/i;
const NOREPLY = /(no-?reply|noreply|donotreply|mailer-daemon|bounce)/i;
const OTP = /(otp|one-time|verification code|код подтвержден|код активац|kich hoat)/i;
const UNSUB = /(unsubscribe|отписаться|вы получили это письмо)/i;
const PROMO = /(promo|sale|акци|скидк|вебинар|webinar|распродаж|x3)/i;
const NEWS = /(newsletter|digest|дайджест|вестник|новости недели|подборк)/i;
const INVOICE = /(invoice|receipt|сч[её]т|инвойс|чек|payment report|реестр пополнен|квитанц)/i;
const ACCEPT = /(приёмк|приемк|возврат|точка выдачи|заберите|накладн|поставк)/i;
const ORDER = /(где мой заказ|заказ\s*№|order\s*#|трек|доставк|отмен)/i;

export function heuristicType(sender: string, subject: string, body: string): { email_type: EmailType; confidence: number } | null {
  const s = subject + '\n' + body;
  if (OURS.test(sender)) return { email_type: 'our_outbound', confidence: 0.95 };
  if (OTP.test(s)) return { email_type: 'otp_transactional', confidence: 0.9 };
  if (ACCEPT.test(s)) return { email_type: 'marketplace_acceptance', confidence: 0.8 };
  if (INVOICE.test(s)) return { email_type: 'invoice', confidence: 0.75 };
  if (ORDER.test(s)) return { email_type: 'order_issue', confidence: 0.75 };
  if (PROMO.test(s)) return { email_type: 'promo', confidence: 0.7 };
  if (NEWS.test(s) || UNSUB.test(body)) return { email_type: 'newsletter', confidence: 0.7 };
  if (NOREPLY.test(sender)) return { email_type: 'cold_spam', confidence: 0.5 };
  return null;
}

export async function classifyEmail(
  env: Env,
  m: { sender: string; subject: string; body: string },
): Promise<{ email_type: EmailType; confidence: number; source: 'heuristic' | 'llm' }> {
  const h = heuristicType(m.sender || '', m.subject || '', (m.body || '').slice(0, 600));
  if (h) return { ...h, source: 'heuristic' };
  try {
    const key = (env as unknown as { OPENROUTER_ERP?: string }).OPENROUTER_ERP;
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
        max_tokens: 16,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Classify the email into exactly ONE type from this list, reply with ONLY the type token: ' + EMAIL_TYPES.join(', ') + '.' },
          { role: 'user', content: 'From: ' + m.sender + '\nSubject: ' + m.subject + '\n' + (m.body || '').slice(0, 600) },
        ],
      }),
    });
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const out = String(j?.choices?.[0]?.message?.content || '').trim().toLowerCase();
    const found = EMAIL_TYPES.find((t) => out.includes(t));
    if (found) return { email_type: found, confidence: 0.6, source: 'llm' };
  } catch {
    /* fall through to default */
  }
  return { email_type: 'support_question', confidence: 0.3, source: 'llm' };
}

import type { Env } from '../types';
import { queueItems } from './browser-queue.mjs';

export type ScenarioMessage = { id?: string; direction: string; text?: string | null; attachments_json?: string | null; created_at: string; unsupported?: boolean };
export type ScenarioPlan = { status?: string; incomingAt?: string; completedAt?: number;
  completion?: { creatorId?: string }; items?: Array<{ text?: string; imageUrl?: string; status?: string; messageId?: string }> };
export function completeScenario(plan: ScenarioPlan, creatorId: string | undefined, after: number): boolean {
  const items = plan.items ?? [], cards = items.filter(item => item.imageUrl);
  return Boolean(creatorId) && plan.status === 'complete' && plan.completion?.creatorId === creatorId
    && Number.isFinite(plan.completedAt) && Number(plan.completedAt) > after
    && Date.parse(plan.incomingAt ?? '') >= after && cards.length === 4
    && new Set(cards.map(card => card.imageUrl)).size === 4
    && items.every(item => item.status === 'sent' && Boolean(item.messageId))
    && new Set(items.map(item => item.messageId)).size === items.length;
}

/** One receipt-based contract for both reply processing and the model-free wake probe. */
export function scenarioEvidence(input: { history: ScenarioMessage[]; deliveryPlans: ScenarioPlan[]; creatorId?: string | undefined;
  stage?: string | null | undefined; orderAt?: string | undefined; lastOutIndex: number; incomingAt: string }) {
  const { history, deliveryPlans, creatorId, stage, orderAt, lastOutIndex, incomingAt } = input;
  const scenarioPlans = deliveryPlans.filter(plan => plan.completion?.creatorId === creatorId && Boolean(creatorId));
  const knownTextReceipts = new Map<string, string>();
  for (const plan of deliveryPlans) {
    const items = plan.items ?? [];
    if (plan.status === 'complete' && items.length && items.every(item => !item.imageUrl
      && typeof item.text === 'string' && item.status === 'sent' && Boolean(item.messageId))) {
      for (const item of items) knownTextReceipts.set(item.messageId!, item.text!);
    }
  }
  const knownTextOnly = (message: ScenarioMessage) => Boolean(message.id && knownTextReceipts.has(message.id)
    && knownTextReceipts.get(message.id) === message.text && (!message.attachments_json || message.attachments_json === '[]'));
  const scenarioOrderAt = Date.parse(orderAt ?? '') || 0;
  const scenarioSent = Boolean(scenarioOrderAt && scenarioPlans.some(plan => completeScenario(plan, creatorId, scenarioOrderAt)));
  const partialScenario = Boolean(scenarioOrderAt && scenarioPlans.some(plan => Date.parse(plan.incomingAt ?? '') >= scenarioOrderAt
    && (plan.items ?? []).some(item => item.imageUrl && item.status === 'sent' && item.messageId)
    && !completeScenario(plan, creatorId, scenarioOrderAt)));
  const currentOwnIdeaAt = Math.max(0, ...history.slice(lastOutIndex + 1).filter(m => m.direction === 'in'
    && /(^|[^а-яё])(?:есть\s+(?:своя\s+)?идея|сниму\s+по\s+своему\s+сценарию)([^а-яё]|$)/i.test(m.text ?? '')
    && !/(?:нет|не)\s+(?:своей\s+)?идеи/i.test(m.text ?? '')).map(m => Date.parse(m.created_at)));
  const scenarioStageReached = ['creation', 'posted', 'gold'].includes(stage ?? '')
    || Boolean(scenarioOrderAt && currentOwnIdeaAt > scenarioOrderAt);
  const legacyScenarioMessages = orderAt ? history.filter(m => m.direction === 'out' && m.created_at > orderAt
    && ((m.attachments_json && m.attachments_json !== '[]') || /сценари|карточк/i.test(m.text ?? ''))) : [];
  const legacyScenarioUncertain = !scenarioPlans.length && legacyScenarioMessages.some(message => !knownTextOnly(message));
  const unknownDelivery = deliveryPlans.some(plan => plan.status === 'ambiguous'
    || (plan.items ?? []).some(item => item.status === 'sending'));
  const textOnlyScenario = !partialScenario && !unknownDelivery && (scenarioStageReached || legacyScenarioUncertain || scenarioSent);
  const safeFirstCards = ['paid', 'ordered'].includes(stage ?? '') && legacyScenarioMessages.length > 0
    && legacyScenarioMessages.every(knownTextOnly) && !deliveryPlans.some(plan => (plan.items ?? []).some(item => item.imageUrl));
  const safeTextOnly = textOnlyScenario && ['paid', 'ordered', 'creation', 'posted', 'gold'].includes(stage ?? '');
  const canResumeReview = !unknownDelivery && !partialScenario && !deliveryPlans.some(plan => plan.incomingAt === incomingAt)
    && (safeFirstCards || safeTextOnly);
  return { scenarioPlans, scenarioOrderAt, currentOwnIdeaAt, scenarioSent, partialScenario, scenarioStageReached, legacyScenarioUncertain,
    unknownDelivery, textOnlyScenario, canResumeReview };
}

export const saidOrdered = (m: ScenarioMessage) => /(^|[^а-яё])(заказала|заказал|оформила|оформил|заказ оформлен|оформлено)([^а-яё]|$)/i.test(m.text ?? '')
  && !/(^|[^а-яё])(не|ещё не|еще не)\s+(заказала|заказал|оформила|оформил)/i.test(m.text ?? '');
export function orderEvidence(history: ScenarioMessage[], payouts: Array<{ status: string; paid_at?: string | null; sent_at?: string | null }>) {
  const moneyAt = payouts.filter(p => p.status === 'paid' || p.status === 'sent')
    .map(p => Date.parse(String(p.paid_at || p.sent_at || ''))).filter(Number.isFinite).sort((a,b) => b-a)[0];
  const orderAt = moneyAt ? history.find(m => m.direction === 'in' && Date.parse(m.created_at) > moneyAt
    && ((m.attachments_json && m.attachments_json !== '[]') || m.unsupported || saidOrdered(m)))?.created_at : undefined;
  return { moneyAt, orderAt, orderShown: Boolean(orderAt) };
}

// Start from incidents, not every archived conversation. All reads are bounded and
// no receipt, cadence, incident, lease or handled marker is changed by this probe.
export const IG_REPLY_WAKE_SQL = `SELECT m.conversation_id cid,m.created_at t,LOWER(m.from_username) h,
    json_extract(s.value,'$.status') status,c.id creator_id,c.lifecycle_stage stage,c.archived_at,browser.value browser_value
  FROM crm_sync_state s JOIN ugc_ig_messages m ON s.key='ig_reply_escalated:'||m.conversation_id
    AND json_valid(s.value) AND json_extract(s.value,'$.at')=m.created_at
  LEFT JOIN ugc_creator_platforms p ON p.platform='instagram' AND p.normalized_handle=LOWER(m.from_username)
  LEFT JOIN ugc_creators c ON c.id=p.creator_id
  LEFT JOIN crm_sync_state browser ON browser.key='browser_queue:'||LOWER(m.from_username)
  WHERE s.key LIKE 'ig_reply_escalated:%' AND m.direction='in' AND m.from_username IS NOT NULL
    AND m.created_at>=?1 AND m.created_at<=?2 AND c.archived_at IS NULL
    AND json_extract(s.value,'$.kind')='technical'
    AND ((json_extract(s.value,'$.status')='retry' AND COALESCE(json_extract(s.value,'$.next_retry_at'),0)<=?3)
      OR (json_extract(s.value,'$.status')='needs_review'
        AND json_extract(s.value,'$.reason')='send_failed: scenario_resend_unverified'))
    AND NOT EXISTS(SELECT 1 FROM ugc_ig_messages newer WHERE newer.conversation_id=m.conversation_id AND newer.created_at>m.created_at)
    AND NOT EXISTS(SELECT 1 FROM crm_sync_state done WHERE done.key='ig_reply:'||m.conversation_id AND done.value>=m.created_at)
    AND NOT EXISTS(SELECT 1 FROM crm_sync_state plan WHERE plan.key='ig_reply_delivery:'||m.conversation_id||':'||m.created_at)
    AND NOT EXISTS(SELECT 1 FROM crm_sync_state owner WHERE owner.key='ig_owner_decision:'||m.conversation_id
      AND json_valid(owner.value) AND json_extract(owner.value,'$.at')=m.created_at)
  ORDER BY m.created_at ASC LIMIT 20`;

type WakeCandidate = { cid: string; t: string; h: string; status: string; creator_id?: string; stage?: string | null; archived_at?: number | null; browser_value?: string | null };
export async function actionableIgReplyRetries(env: Env, now = Date.now()): Promise<WakeCandidate[]> {
  const candidates = (await env.DB.prepare(IG_REPLY_WAKE_SQL)
    .bind(new Date(now - 7 * 86_400_000).toISOString(), new Date(now - 90_000).toISOString(), now).all<WakeCandidate>()).results ?? [];
  const actionable: WakeCandidate[] = [];
  for (const row of candidates) {
    if (row.browser_value && queueItems([{key: 'browser_queue:'+row.h, value: row.browser_value}]).length) continue;
    if (row.stage && ['refused', 'rival', 'archived', 'owner', 'paused'].includes(row.stage)) continue;
    const prefix = `ig_reply_delivery:${row.cid}:`;
    const records = (await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key>=?1 AND key<?2`)
      .bind(prefix, prefix+'\uffff').all<{ value: string }>()).results ?? [];
    let plans: ScenarioPlan[];
    try { plans = records.map(record => JSON.parse(record.value) as ScenarioPlan); } catch { continue; }
    // A current immutable plan belongs to the outbox. Unknown or partially sent
    // historical plans require that path/review, never a regenerated reply.
    if (plans.some(plan => !plan || !Array.isArray(plan.items) || plan.incomingAt === row.t
      || ['ambiguous', 'browser', 'pending'].includes(plan.status ?? '')
      || plan.items.some(item => item.status === 'sending')
      || (plan.items.some(item => item.imageUrl && item.status === 'sent')
        && !completeScenario(plan, row.creator_id, 0)))) continue;
    if (row.status === 'retry') { actionable.push(row); continue; }
    const history = ((await env.DB.prepare(`SELECT m.id,m.direction,m.text,m.attachments_json,m.created_at,
        EXISTS(SELECT 1 FROM crm_sync_state probe WHERE probe.key='ig_attachment_probe:'||m.id AND probe.value='unsupported_by_instagram') unsupported
      FROM ugc_ig_messages m WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 60`).bind(row.cid).all<ScenarioMessage>()).results ?? []).reverse();
    const payouts = row.creator_id ? ((await env.DB.prepare(`SELECT status,paid_at,sent_at FROM ugc_payouts
      WHERE creator_id=?1 ORDER BY created_at DESC LIMIT 5`).bind(row.creator_id)
      .all<{ status: string; paid_at?: string; sent_at?: string }>()).results ?? []) : [];
    const { orderAt } = orderEvidence(history, payouts);
    if (scenarioEvidence({ history, deliveryPlans: plans, creatorId: row.creator_id, stage: row.stage,
      orderAt, incomingAt: row.t, lastOutIndex: history.map(m => m.direction).lastIndexOf('out') }).canResumeReview) actionable.push(row);
  }
  return actionable;
}

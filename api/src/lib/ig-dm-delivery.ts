import type { Env } from '../types';

export type IgDeliveryPlan = {
  conversationId: string;
  incomingAt: string;
  handle: string;
  parts: string[];
  cards?: string[];
  humanAgent?: boolean;
  completion?: { creatorId: string; expectedStage: string | null; expectedUpdatedAt: number | null };
};
export type IgDeliverySender = (env: Env, handle: string, text: string, opts: { humanAgent?: boolean; imageUrl?: string }) => Promise<{
  ok: boolean; messageId?: string; error?: string; delivery?: 'not_sent' | 'unknown';
}>;
type Item = { text?: string; imageUrl?: string; status: 'pending' | 'sending' | 'sent'; messageId?: string };
type State = Omit<IgDeliveryPlan, 'parts' | 'cards'> & {
  version: 1; items: Item[]; completedAt?: number; status: 'pending' | 'ambiguous' | 'complete' | 'superseded' | 'browser';
  leaseToken?: string | undefined; leaseUntil?: number | undefined; error?: string | undefined; acknowledgedAt?: number; browserQueue?: boolean;
};
export type IgDeliveryResult = {
  key: string; conversationId: string; incomingAt: string; handle: string;
  status: State['status'] | 'busy'; sent: number; total: number; error?: string; attempted?: boolean;
  completion?: IgDeliveryPlan['completion'];
};
const PREFIX = 'ig_reply_delivery:';
const LEASE_MS = 5 * 60_000;
export const igDeliveryKey = (conversationId: string, incomingAt: string) => `${PREFIX}${conversationId}:${incomingAt}`;

function decode(value: string): State {
  const state = JSON.parse(value) as State;
  if (state.version !== 1 || !state.conversationId || !state.incomingAt || !Array.isArray(state.items)) throw new Error('Invalid Instagram delivery state');
  return state;
}
function result(key: string, state: State, status: IgDeliveryResult['status'] = state.status): IgDeliveryResult {
  return { key, conversationId: state.conversationId, incomingAt: state.incomingAt, handle: state.handle,
    status, sent: state.items.filter(item => item.status === 'sent' && item.messageId).length, total: state.items.length,
    ...(state.error ? { error: state.error } : {}), ...(state.completion ? { completion: state.completion } : {}) };
}
async function read(env: Env, key: string): Promise<string | null> {
  return (await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{ value: string }>())?.value ?? null;
}

/** A fixed plan is immutable after creation, including when a later model draft differs. */
export async function deliverIgReply(env: Env, plan: IgDeliveryPlan, send: IgDeliverySender): Promise<IgDeliveryResult> {
  const key = igDeliveryKey(plan.conversationId, plan.incomingAt);
  const state: State = { version: 1, conversationId: plan.conversationId, incomingAt: plan.incomingAt,
    handle: plan.handle, ...(plan.humanAgent !== undefined ? { humanAgent: plan.humanAgent } : {}),
    ...(plan.completion ? { completion: plan.completion } : {}), status: 'pending',
    items: [...plan.parts.filter(Boolean).map(text => ({ text, status: 'pending' as const })),
      ...(plan.cards ?? []).map(imageUrl => ({ imageUrl, status: 'pending' as const }))] };
  // Do not call Instagram unless both the intent and subsequent per-item claim are durable.
  await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO NOTHING`)
    .bind(key, JSON.stringify(state), Date.now()).run();
  const stored = await read(env, key);
  if (!stored) throw new Error('Instagram delivery plan was not persisted');
  return advance(env, key, stored, send);
}

/** Resume independently of the latest message's direction: a partial reply is still work. */
export async function resumeIgDeliveries(env: Env, send: IgDeliverySender, limit = 15): Promise<IgDeliveryResult[]> {
  const rows = (await env.DB.prepare(`SELECT key,value FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%'
    AND json_valid(value) AND json_extract(value,'$.status')<>'superseded'
    AND json_extract(value,'$.acknowledgedAt') IS NULL
    ORDER BY CASE WHEN json_extract(value,'$.status')='ambiguous' THEN 1 ELSE 0 END, updated_at LIMIT ?1`)
    .bind(limit).all<{ key: string; value: string }>()).results ?? [];
  const results: IgDeliveryResult[] = [];
  for (const row of rows) results.push(await advance(env, row.key, row.value, send));
  return results;
}

async function advance(env: Env, key: string, raw: string, send: IgDeliverySender): Promise<IgDeliveryResult> {
  let state = decode(raw);
  let attempted = false;
  const report = (status: IgDeliveryResult['status'] = state.status) => ({ ...result(key, state, status), attempted });
  if (state.status === 'complete' || state.status === 'browser' || state.status === 'superseded' || state.status === 'ambiguous') return report();
  if (state.browserQueue) return report();
  if (state.leaseToken && (state.leaseUntil ?? 0) > Date.now()) return report('busy');
  // CAS each transition. A lost acknowledgement can be confirmed by reading the
  // exact intended value; it must never cause the network send to repeat.
  const save = async (next: State) => {
    const value = JSON.stringify(next);
    try {
      const updated = await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4')
        .bind(key, value, Date.now(), raw).run();
      if (updated.meta?.changes !== 1 && await read(env, key) !== value) throw new Error('Instagram delivery claim changed');
    } catch (error) {
      if (await read(env, key).catch(() => null) !== value) throw error;
    }
    raw = value; state = next;
  };
  // Sending intent without a receipt is ambiguous after interruption. Do not
  // replay: a later reconciliation can use the archived Meta message evidence.
  if (state.items.some(item => item.status === 'sending')) {
    await save({ ...state, status: 'ambiguous', error: 'delivery_interrupted_without_receipt', leaseToken: undefined, leaseUntil: undefined });
    return report();
  }
  const latest = await env.DB.prepare(`SELECT MAX(created_at) t FROM ugc_ig_messages WHERE conversation_id=?1 AND direction='in'`)
    .bind(state.conversationId).first<{ t: string | null }>();
  if (latest?.t && Date.parse(latest.t) > Date.parse(state.incomingAt)) {
    await save({ ...state, status: 'superseded', error: 'newer_incoming_message', leaseToken: undefined, leaseUntil: undefined });
    return report();
  }
  try {
    await save({ ...state, leaseToken: crypto.randomUUID(), leaseUntil: Date.now() + LEASE_MS, error: undefined });
  } catch {
    const current = await read(env, key);
    if (current && current !== raw) return result(key, decode(current), 'busy');
    throw new Error('Instagram delivery claim unavailable');
  }
  attempted = true;
  let sentTextThisAttempt = false;
  for (let index = 0; index < state.items.length; index++) {
    if (state.items[index]!.status === 'sent') continue;
    // Preserve Diana's existing short pause between consecutive text messages.
    if (sentTextThisAttempt && state.items[index]!.text !== undefined) await new Promise(resolve => setTimeout(resolve, 1500));
    const items = state.items.map((item, i) => i === index ? { ...item, status: 'sending' as const } : item);
    await save({ ...state, items, leaseUntil: Date.now() + LEASE_MS });
    const item = state.items[index]!;
    let receipt: Awaited<ReturnType<IgDeliverySender>>;
    try { receipt = await send(env, state.handle, item.text ?? '', { ...(state.humanAgent !== undefined ? { humanAgent: state.humanAgent } : {}), ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}) }); }
    catch { receipt = { ok: false, delivery: 'unknown', error: 'delivery_transport_exception' }; }
    if (receipt.ok && receipt.messageId) {
      const messageId = receipt.messageId;
      const delivered = state.items.map((part, i) => i === index ? { ...part, status: 'sent' as const, messageId } : part);
      try { await save({ ...state, items: delivered }); }
      catch {
        // The durable sending intent prevents a replay even when receipt storage fails.
        return { ...report('ambiguous'), error: 'delivery_receipt_not_persisted' };
      }
      sentTextThisAttempt = item.text !== undefined;
      continue;
    }
    const knownUnsent = receipt.delivery === 'not_sent';
    await save({ ...state, status: knownUnsent ? 'pending' : 'ambiguous',
      items: state.items.map((part, i) => i === index && knownUnsent ? { ...part, status: 'pending' as const } : part),
      error: (receipt.error ?? 'delivery_missing_receipt').slice(0, 200), leaseToken: undefined, leaseUntil: undefined });
    return report();
  }
  await save({ ...state, status: 'complete', completedAt: Date.now(), error: undefined, leaseToken: undefined, leaseUntil: undefined });
  return report();
}

/** Call only after the corresponding handled marker and factual stage updates persist. */
export async function acknowledgeIgDelivery(env: Env, key: string): Promise<void> {
  const raw = await read(env, key);
  if (!raw) throw new Error('Instagram delivery plan missing');
  const state = decode(raw);
  if (state.status !== 'complete' && state.status !== 'browser') throw new Error('Instagram delivery is incomplete');
  if (state.acknowledgedAt) return;
  const value = JSON.stringify({ ...state, acknowledgedAt: Date.now() });
  const updated = await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4')
    .bind(key, value, Date.now(), raw).run();
  if (updated.meta?.changes !== 1 && await read(env, key) !== value) throw new Error('Instagram delivery acknowledgement changed');
}

/** Browser fallback accepts only the known-unsent text suffix, with a stable dedupe ID. */
export async function queueIgDeliveryTexts(env: Env, key: string,
  queue: (handle: string, text: string, deliveryKey: string) => Promise<void>): Promise<boolean> {
  let raw = await read(env, key);
  if (!raw) throw new Error('Instagram delivery plan missing');
  let state = decode(raw);
  if (state.status === 'browser') return true;
  if (state.status !== 'pending' || state.leaseToken || !/allowed window/i.test(state.error ?? '')) return false;
  const remaining = state.items.filter(item => item.status !== 'sent');
  if (!remaining.length || remaining.some(item => item.status !== 'pending' || item.imageUrl)) return false;
  if (!state.browserQueue) {
    const intent = JSON.stringify({ ...state, browserQueue: true });
    const claimed = await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4')
      .bind(key, intent, Date.now(), raw).run();
    if (claimed.meta?.changes !== 1 && await read(env, key) !== intent) throw new Error('Instagram browser handoff claim changed');
    raw = intent; state = decode(intent);
  }
  await queue(state.handle, remaining.map(item => item.text ?? '').join('\n'), key);
  const value = JSON.stringify({ ...state, status: 'browser' });
  const updated = await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4')
    .bind(key, value, Date.now(), raw).run();
  if (updated.meta?.changes !== 1 && await read(env, key) !== value) throw new Error('Instagram browser handoff changed');
  return true;
}

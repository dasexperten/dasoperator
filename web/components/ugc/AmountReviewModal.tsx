'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { apiGet, apiPostTimed } from '@/lib/api';
import { formatRub } from '@/lib/ugc-payout-cell.mjs';
import { createAmountReviewSession, parseReviewAmount, reviewAmountInput, type AmountReview, type AmountReviewSaved, type AmountReviewSession, type AmountReviewState } from '@/lib/ugc-amount-review.mjs';

export type AmountReviewTarget = { id: string; creatorId: string; handle?: string | null };
type Props = { target: AmountReviewTarget | null; onClose: () => void; onSaved: (row: AmountReviewSaved) => void };
const INITIAL: AmountReviewState = { phase: 'loading', review: null, request: null, error: '' };

// GET uses a deadline too. A late reply cannot mutate the session after timeout.
function withDeadline<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

export function AmountReviewModal({ target, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sessions = useRef(new Map<string, AmountReviewSession>());
  const current = useRef<AmountReviewSession | null>(null);
  const callbacks = useRef({ onClose, onSaved });
  callbacks.current = { onClose, onSaved };
  const [state, setState] = useState<AmountReviewState>(INITIAL);
  const [amount, setAmount] = useState('');

  useEffect(() => {
    if (!target) return;
    const key = `${target.creatorId}:${target.id}`;
    let session = sessions.current.get(key);
    if (!session) {
      session = createAmountReviewSession({
        id: target.id,
        creatorId: target.creatorId,
        requestId: () => crypto.randomUUID(),
        read: (id, requestId) => withDeadline(apiGet<AmountReview>(`/api/ugc/payouts/${encodeURIComponent(id)}/amount-review${requestId ? `?request_id=${encodeURIComponent(requestId)}` : ''}`)),
        save: (id, request) => apiPostTimed<AmountReviewSaved>(`/api/ugc/payouts/${encodeURIComponent(id)}/amount-review`, request, 20_000),
        onSaved: (row) => callbacks.current.onSaved(row),
      });
      sessions.current.set(key, session);
    }
    current.current = session;
    setState(session.getState());
    setAmount(session.getState().request ? reviewAmountInput(session.getState().request!.amount_minor) : '');
    const unsubscribe = session.subscribe(setState);
    void session.open();
    const element = dialog.current;
    element?.showModal();
    const dismiss = () => callbacks.current.onClose();
    // Back/Forward dismisses only; it never submits or replays the request.
    window.addEventListener('popstate', dismiss);
    return () => {
      unsubscribe();
      current.current = null;
      element?.close();
      window.removeEventListener('popstate', dismiss);
    };
  }, [target?.id, target?.creatorId]);

  useEffect(() => { if (state.phase === 'ready') input.current?.focus(); }, [state.phase]);

  if (!target) return null;
  const busy = ['loading', 'saving', 'checking'].includes(state.phase);
  const retry = state.phase === 'retry';
  const ready = state.phase === 'ready';
  const valid = !parseReviewAmount(amount).error;
  const buttonStyle = { border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', minHeight: 44, padding: '8px 16px' };

  return createPortal(<dialog ref={dialog} aria-labelledby="ugc-amount-title" aria-describedby="ugc-amount-help" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.stopPropagation()} style={{ width: 'min(480px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto', padding: 24, color: 'var(--fg-1)', background: 'var(--bg-surface)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-float)' }}>
    <div className="flex items-start justify-between gap-4">
      <h2 id="ugc-amount-title" className="text-lg font-semibold">Сохранить сумму</h2>
      <button type="button" aria-label="Закрыть" onClick={onClose} style={buttonStyle}><X size={16} aria-hidden="true" /></button>
    </div>
    <p className="mt-2">{target.handle ? `@${target.handle.replace(/^@/, '')}` : 'Выплата блогеру'}</p>
    <p id="ugc-amount-help" className="mt-3 text-sm">Только сумма корзины, без оплаты. Выплата останется на проверке. Реквизиты, банк и соответствие переписке проверяются отдельно.</p>
    <form className="mt-4" onSubmit={(event) => { event.preventDefault(); void current.current?.submit(amount); }}>
      <label htmlFor="ugc-review-amount" className="block text-sm font-medium">Сумма, ₽</label>
      <input ref={input} id="ugc-review-amount" type="text" inputMode="decimal" autoComplete="off" autoFocus placeholder="453,00" value={state.request ? reviewAmountInput(state.request.amount_minor) : amount} disabled={!ready || busy || Boolean(state.request)} onChange={(event) => setAmount(event.target.value)} aria-describedby="ugc-amount-range" aria-invalid={Boolean(amount && !valid)} className="mt-2 w-full px-3" style={{ minHeight: 44, color: 'var(--fg-1)', background: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)' }} />
      <p id="ugc-amount-range" className="mt-2 text-sm">От 50 до 999 ₽, с точностью до копейки.</p>
      {busy && <p role="status" className="mt-3 text-sm">{state.phase === 'saving' ? 'Сохраняем сумму, без оплаты…' : 'Проверяем эту выплату…'}</p>}
      {state.error && <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--status-error)' }}>{state.error}</p>}
      {state.phase === 'saved' && <p role="status" className="mt-3 text-sm">{formatRub(state.review?.amount_minor)} сохранено. Требует проверки. Оплата не запускалась.</p>}
      {state.phase === 'blocked' && state.review && <p className="mt-2 text-sm">Текущая сумма: {state.review.amount_minor === 1 ? 'не подтверждена' : formatRub(state.review.amount_minor)}. {state.review.payout_hold ? 'Выплата на проверке.' : ''}</p>}
      {state.request && state.phase !== 'saved' && <p className="mt-3 text-sm">Закрытие окна не отменяет уже отправленный запрос. При повторном открытии проверим ту же запись.</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} style={buttonStyle}>{state.request ? 'Назад к списку' : 'Отмена'}</button>
        {state.phase === 'error' || state.phase === 'blocked' ? <button type="button" onClick={() => { void current.current?.open(); }} style={buttonStyle}>Проверить состояние</button> : null}
        {ready || retry || state.phase === 'saving' ? <button type="submit" disabled={busy || (!retry && !valid)} style={{ ...buttonStyle, fontWeight: 600, opacity: busy || (!retry && !valid) ? 0.55 : 1 }}>{retry ? 'Повторить сохранение, без оплаты' : 'Сохранить сумму, без оплаты'}</button> : null}
      </div>
    </form>
  </dialog>, document.body);
}

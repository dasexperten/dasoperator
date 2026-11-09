// Component event tests with a small deterministic hook host. These cover the
// real component handlers without a browser, network, storage or production API.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as review from '../../lib/ugc-amount-review.mjs';
import * as cells from '../../lib/ugc-payout-cell.mjs';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('./AmountReviewModal.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const UUID = '12345678-1234-4123-8123-123456789abc';
const ROW = { id: 'synthetic-payout', creator_id: 'synthetic-creator', amount_minor: 1, status: 'approved', payout_hold: false, review_snapshot: 'a'.repeat(64), can_edit: true };
const TARGET = { id: ROW.id, creatorId: ROW.creator_id, handle: 'synthetic_creator' };
const ok = (result) => ({ success: true, result });
const receipt = (request) => ({ ...ROW, amount_minor: request.amount_minor, payout_hold: true, can_edit: false, review_snapshot: 'b'.repeat(64), saved_request: { ...request } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function mount({ read = async () => ok(ROW), save = async (_, request) => ok(receipt(request)) } = {}) {
  const hooks = []; let index = 0; let dirty = true; let tree; let target = TARGET; let effects = [];
  const calls = []; const saved = []; const events = new Map(); const refs = { dialog: { open: false, showModal() { this.open = true; }, close() { this.open = false; } }, input: { focus() {} } };
  const React = {
    useRef(value) { const slot = index++; return hooks[slot] ??= { current: value }; },
    useState(value) { const slot = index++; hooks[slot] ??= { value: typeof value === 'function' ? value() : value }; return [hooks[slot].value, (next) => { const value = typeof next === 'function' ? next(hooks[slot].value) : next; if (value !== hooks[slot].value) { hooks[slot].value = value; dirty = true; } }]; },
    useEffect(effect, deps) { const slot = index++; const prev = hooks[slot]; if (!prev || deps.some((v, i) => !Object.is(v, prev.deps[i]))) { hooks[slot] = { deps, cleanup: prev?.cleanup }; effects.push(() => { hooks[slot].cleanup?.(); hooks[slot].cleanup = effect(); }); } },
  };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, { exports: module.exports, module, setTimeout, clearTimeout, crypto: { randomUUID: () => UUID }, document: { body: {} }, window: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); } }, require: (name) => {
    if (name === 'react') return React;
    if (name === 'lucide-react') return { X: () => null };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-dom') return { createPortal: (child) => child };
    if (name === '@/lib/api') return { apiGet: async (...args) => { calls.push(['GET', ...args]); return read(...args); }, apiPostTimed: async (...args) => { calls.push(['POST', ...args]); return save(...args); } };
    if (name === '@/lib/ugc-amount-review.mjs') return review;
    if (name === '@/lib/ugc-payout-cell.mjs') return cells;
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  const nodes = () => {
    const list = [];
    const walk = (node) => { if (node == null || typeof node === 'boolean') return; if (Array.isArray(node)) return node.forEach(walk); if (typeof node !== 'object') { list.push(node); return; } list.push(node); walk(node.props?.children); };
    walk(tree); return list;
  };
  const render = () => {
    for (let count = 0; dirty && count < 20; count++) {
      dirty = false; index = 0; effects = [];
      tree = module.exports.AmountReviewModal({ target, onClose: () => { target = null; dirty = true; }, onSaved: (row) => saved.push(row) });
      for (const node of nodes()) if (node?.props?.ref) node.props.ref.current = refs[node.type];
      const pendingEffects = effects; effects = []; pendingEffects.forEach((effect) => effect());
    }
    assert.equal(dirty, false, 'hook render stabilized');
  };
  const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(setImmediate); render(); } };
  render();
  return { calls, saved, refs, flush, nodes, get target() { return target; }, render, text: () => nodes().filter((node) => typeof node === 'string').join(' ').replace(/\s+/g, ' '), find: (type, predicate = () => true) => nodes().find((node) => node?.type === type && predicate(node.props)), open(next = TARGET) { target = next; dirty = true; render(); }, pop() { events.get('popstate')?.(); render(); }, close() { const button = nodes().find((node) => node?.type === 'button' && node.props['aria-label'] === 'Закрыть'); button.props.onClick(); render(); }, cancel() { const dialog = nodes().find((node) => node?.type === 'dialog'); dialog.props.onCancel({ preventDefault() {} }); render(); }, input(value) { const input = nodes().find((node) => node?.type === 'input'); input.props.onChange({ target: { value } }); render(); }, submit() { const form = nodes().find((node) => node?.type === 'form'); form.props.onSubmit({ preventDefault() {} }); render(); } };
}

test('dialog is labelled, fetches only review data, and has explicit close and cancel', async () => {
  const ui = mount(); await ui.flush();
  assert.equal(ui.refs.dialog.open, true);
  assert.equal(ui.find('dialog').props['aria-labelledby'], 'ugc-amount-title');
  assert.equal(ui.find('input').props.inputMode, 'decimal');
  assert.equal(ui.find('input').props.disabled, false);
  assert.match(ui.text(), /Только сумма корзины, без оплаты/);
  assert.ok(ui.find('button', (props) => props.children === 'Отмена'));
  assert.deepEqual(ui.calls.map(([verb, path]) => [verb, path]), [['GET', `/api/ugc/payouts/${ROW.id}/amount-review`]]);
  ui.close(); assert.equal(ui.target, null); assert.equal(ui.refs.dialog.open, false);
});

test('fractional submit is exact, double click is locked, and success shows held amount', async () => {
  const pending = deferred(); let request;
  const ui = mount({ save: async (_, body) => { request = body; await pending.promise; return ok(receipt(body)); } });
  await ui.flush(); ui.input('453,27'); ui.submit(); ui.submit();
  assert.equal(ui.calls.filter(([verb]) => verb === 'POST').length, 1);
  assert.equal(request.amount_minor, 45327);
  assert.equal(ui.find('button', (p) => p.type === 'submit').props.disabled, true);
  assert.equal(ui.find('input').props.disabled, true);
  pending.resolve(); await ui.flush();
  assert.match(ui.text(), /453,27 ₽ сохранено/); assert.match(ui.text(), /Требует проверки/);
  assert.equal(ui.saved.length, 1);
  assert.equal(ui.calls.some(([, path]) => /execute|paid-outside|approve/.test(path)), false);
});

test('invalid input disables save and form-level validation prevents bypass', async () => {
  const ui = mount(); await ui.flush(); ui.input('453.001');
  assert.equal(ui.find('button', (p) => p.type === 'submit').props.disabled, true);
  ui.submit(); await ui.flush();
  assert.equal(ui.calls.filter(([verb]) => verb === 'POST').length, 0);
  assert.match(ui.text(), /не больше двух знаков/);
});

test('Escape and browser Back dismiss without submitting or changing history', async () => {
  const ui = mount(); await ui.flush(); ui.input('394'); ui.cancel();
  assert.equal(ui.refs.dialog.open, false); ui.open(); await ui.flush(); ui.pop();
  assert.equal(ui.refs.dialog.open, false); assert.equal(ui.calls.filter(([verb]) => verb === 'POST').length, 0);
});

test('closing during loading prevents a late response from reopening the dialog', async () => {
  const pending = deferred(); const ui = mount({ read: async () => pending.promise });
  ui.close(); pending.resolve(ok(ROW)); await ui.flush();
  assert.equal(ui.target, null); assert.equal(ui.refs.dialog.open, false); assert.equal(ui.saved.length, 0);
});

test('closed in-flight save reconciles on reopen using the original request without duplicate POST', async () => {
  const pending = deferred(); let request;
  const ui = mount({ read: async () => ok(request ? receipt(request) : ROW), save: async (_, body) => { request = body; await pending.promise; throw new Error('lost response'); } });
  await ui.flush(); ui.input('394'); ui.submit(); ui.close(); pending.resolve(); await ui.flush();
  assert.equal(ui.refs.dialog.open, false); ui.open(); await ui.flush();
  assert.match(ui.text(), /394 ₽ сохранено/);
  assert.equal(ui.calls.filter(([verb]) => verb === 'POST').length, 1);
  assert.ok(ui.calls.some(([verb, path]) => verb === 'GET' && path.endsWith(`?request_id=${UUID}`)));
});

test('changed target ignores the older lookup result and never saves against its identity', async () => {
  const pending = deferred(); const next = { ...TARGET, id: 'synthetic-next', creatorId: 'synthetic-next-creator' };
  const ui = mount({ read: async (path) => path.includes(ROW.id) ? pending.promise : ok({ ...ROW, id: next.id, creator_id: next.creatorId }) });
  ui.open(next); await ui.flush(); pending.resolve(ok(ROW)); await ui.flush(); ui.input('453'); ui.submit(); await ui.flush();
  const post = ui.calls.find(([verb]) => verb === 'POST');
  assert.equal(post[1], `/api/ugc/payouts/${next.id}/amount-review`);
  assert.equal(post[2].creator_id, next.creatorId);
  assert.equal(ui.saved.length, 0, 'mismatched save response is not accepted');
});

test('static wiring keeps admin-only save separate from execute and removes old prompt/PATCH', () => {
  const page = fs.readFileSync(new URL('../../app/ugc/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /amountEditable = Boolean\(isAdmin && payout && canSetPayoutAmount\(payout\)\)/);
  assert.match(page, /target=\{isAdmin \? amountReviewTarget : null\}/);
  assert.match(page, /canMarkPaidOutside\(payout\)/);
  assert.doesNotMatch(page, /window\.prompt/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|\/execute|\/paid-outside|apiPatch/);
});

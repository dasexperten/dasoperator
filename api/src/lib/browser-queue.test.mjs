import test from 'node:test';
import assert from 'node:assert/strict';
import { queueItems, isTarget, cooldownLeft, fireText } from './browser-queue.mjs';

test('queue rows become one entry per blogger, each line its own message', () => {
  const rows = [{ key: 'browser_queue:anna', value: JSON.stringify({ handle: 'Anna', items: [{ text: 'Перевели 500 ₽ по СБП.\nПроверьте, пожалуйста.' }, { text: 'Оформите заказ.' }] }) },
    { key: 'browser_queue:empty', value: JSON.stringify({ handle: 'empty', items: [] }) }, { key: 'browser_queue:bad', value: '{' }];
  assert.deepEqual(queueItems(rows), [{ handle: 'anna', texts: ['Перевели 500 ₽ по СБП.', 'Проверьте, пожалуйста.', 'Оформите заказ.'] }]);
});
test('only pc and mac are targets', () => { assert.ok(isTarget('pc')); assert.ok(isTarget('mac')); assert.ok(!isTarget('linux')); });
test('two-minute guard against a double click', () => {
  assert.equal(cooldownLeft(1_000_000, 1_000_000 + 30_000), 90); assert.equal(cooldownLeft(1_000_000, 1_000_000 + 121_000), 0); assert.equal(cooldownLeft(0, Date.now()), 0);
});
test('launch text carries everything the task needs', () => {
  const t = JSON.parse(fireText({ target: 'mac', run: 'r', key: 'k', doneUrl: 'https://x/done', items: [{ handle: 'a', texts: ['b'] }] }));
  assert.deepEqual(t, { target: 'mac', run: 'r', key: 'k', done_url: 'https://x/done', items: [{ handle: 'a', texts: ['b'] }] });
});

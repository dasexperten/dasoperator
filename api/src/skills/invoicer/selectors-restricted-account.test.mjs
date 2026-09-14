// Run: node --test api/src/skills/invoicer/selectors-restricted-account.test.mjs  (Node ≥ 23, type stripping)
// Guards migration 0087: the DEASEAN VietinBank IRC account never lands on a commercial document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBankAccount, RESTRICTED_BANK_ACCOUNT_IDS } from './selectors.ts';

const company = { abbreviation: 'DEASEAN', legal_name: 'DAS EXPERTEN ASEAN COMPANY LIMITED' };
const row = (id, currency, is_default, account_number) => ({
  id, company_id: 'dasean', account_purpose: 'usd', account_number, currency, is_default, notes: null,
});
const irc = row('cba_dasean_vietin_usd_irc', 'USD', 1, '110003040270');
const ops = row('cba_dasean_vietin_usd', 'USD', 0, '118003040220');

test('IRC id is on the restricted list', () => {
  assert.ok(RESTRICTED_BANK_ACCOUNT_IDS.has('cba_dasean_vietin_usd_irc'));
});

test('USD invoice picks the operating account even if IRC is listed first and flagged default', () => {
  const sel = selectBankAccount(company, 'USD', [irc, ops]);
  assert.equal(sel.account_number, '118003040220');
});

test('IRC alone never becomes the invoice account', () => {
  const sel = selectBankAccount(company, 'USD', [irc]);
  assert.notEqual(sel?.account_number, '110003040270');
});

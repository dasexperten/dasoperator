import test from "node:test";
import assert from "node:assert/strict";
import { parseWioMail, minor } from "./wio-mail.mjs";

// Bodies as Gmail renders the real letters of 2026-09/10 (Arabic half and footer trimmed).
const CREDIT = `| # You've received money :-) |
| Hi Das Experten International LLC, Below are the details. |
| Amount | AED 201.02 |
| From Reference ID Account | NETWORK INTERNATIONAL LLC AEL2610050010350000246 90XXXX9406 |
| We hope it brings you joy. Team Wio |
| AED 201.02 | المبلغ |`;

const LOCAL = `| # Your local transfer is sent |
| Hi Das Experten International LLC, Your local transfer request has been processed. |
| Transfer amount | AED 2,619.75 |
| To | Accuvat Chartered Accounting And Bookkeeping |
| Account | 90XXXX9406 |
| Reference ID | LN17579995839590 |
| Fees charged | Free |
| Total amount debited | AED 2,619.75 |
| This was processed from your account number 90XXXX9406. Team Wio |`;

const INTL = `| # Your transfer is on its way |
| Hi Das Experten International LLC, Your international transfer request has been processed. Want to see where your money’s at? |
| You paid | USD 4,898.30 |
| To Account Reference ID Date Payment method Estimated delivery | World Dentist Association America LLC 91XXXX9772 SW70260991283372 15 Sep 2026 11:12 Correspondent Bank 48-72 hours |`;

test("minor units", () => {
  assert.equal(minor("2,619.75"), 261975);
  assert.equal(minor("201.02"), 20102);
  assert.equal(minor("12,000"), 1200000);
  assert.equal(minor("abc"), null);
});

test("incoming credit", () => {
  const r = parseWioMail(CREDIT, { subject: "You’ve received money 🎉", fallbackDate: "2026-10-05" });
  assert.equal(r.kind, "credit");
  assert.deepEqual(r.problems, []);
  assert.equal(r.transactions.length, 1);
  const t = r.transactions[0];
  assert.equal(t.direction, "incoming");
  assert.equal(t.amount, 20102);
  assert.equal(t.currency, "AED");
  assert.equal(t.account_id, "cba_dei_wio_aed");
  assert.equal(t.contragent_name, "NETWORK INTERNATIONAL LLC");
  assert.equal(t.external_id, "AEL2610050010350000246");
  assert.equal(t.executed_at, "2026-10-05");
});

test("local transfer", () => {
  const r = parseWioMail(LOCAL, { subject: "Your local transfer is sent", fallbackDate: "2026-09-18" });
  assert.deepEqual(r.problems, []);
  const t = r.transactions[0];
  assert.equal(t.direction, "outgoing");
  assert.equal(t.amount, 261975);
  assert.equal(t.contragent_name, "Accuvat Chartered Accounting And Bookkeeping");
  assert.equal(t.external_id, "LN17579995839590");
  assert.equal(t.account_id, "cba_dei_wio_aed");
});

test("international transfer takes its own date and the USD account", () => {
  const r = parseWioMail(INTL, { subject: "Your transfer is on its way", fallbackDate: "2026-09-16" });
  assert.deepEqual(r.problems, []);
  const t = r.transactions[0];
  assert.equal(t.direction, "outgoing");
  assert.equal(t.amount, 489830);
  assert.equal(t.currency, "USD");
  assert.equal(t.account_id, "cba_dei_wio_usd");
  assert.equal(t.contragent_name, "World Dentist Association America LLC");
  assert.equal(t.external_id, "SW70260991283372");
  assert.equal(t.executed_at, "2026-09-15");
});

test("non-money letters are ignored, not flagged", () => {
  const r = parseWioMail("| Your trade license is expiring soon |", { subject: "Your trade license is expiring soon" });
  assert.equal(r.kind, "other");
  assert.equal(r.transactions.length, 0);
  assert.deepEqual(r.problems, []);
});

test("unknown account is a problem, not a silent row", () => {
  const r = parseWioMail(CREDIT.replace("90XXXX9406", "90XXXX1111"), { subject: "You’ve received money", fallbackDate: "2026-10-05" });
  assert.equal(r.transactions.length, 0);
  assert.match(r.problems[0], /unknown Wio account/);
});

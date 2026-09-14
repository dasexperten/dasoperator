# VietinBank — DEASEAN banking in the ERP

**As of:** 2026-09-14 · **Steward:** Justina Timber (finance, banking authority) · migration `0087`

## What is connected now

| Layer | State |
|---|---|
| Bank provider | `bp_vietinbank` · VietinBank – Branch 9 HCMC · SWIFT `ICBVVNVX928` · `auth_method = manual` |
| Accounts (`company_bank_accounts`, company `dasean`) | `cba_dasean_vietin_usd` USD operating (default) · `cba_dasean_vietin_vnd1` VND · `cba_dasean_vietin_vnd2` VND · `cba_dasean_vietin_usd_irc` USD IRC **restricted** |
| Invoices | DEASEAN USD documents pick the operating account. IRC is blocked in code: `RESTRICTED_BANK_ACCOUNT_IDS` in `api/src/skills/invoicer/selectors.ts` |
| Transactions | `/finance` → upload a VietinBank statement (CSV / XLSX / PDF). The parser supports VND and matches by account number |
| Live API | **none** — `api_enabled = 0` on all four |

Account data source: `SKILLS/contacts/reference/das-group/dasean.md` (dasexperten.com). Logins live
only in `organizacia` `secrets` → `SECRETS/vietinbank-deasean.md`; never in this repo.

## What the mailbox says (dasexperten@gmail.com, read 2026-09-14)

15 threads, 21 messages from `VietinBank-eFAST@vietinbank.vn` and `einvoice@vietinbank.vn`,
Jan–Jul 2026. **Not one concerns an API.**

| Kind | Count | Content |
|---|---:|---|
| eFAST login pack | 4 | temporary password for eFAST web (09.01) — value never copied |
| OTP activation code | 3 | Soft OTP activation (09.01 ×2, 17.06) |
| App login verification | 2 | new device login codes (11.06) |
| Terms update eFAST | 3 | image-only notice (23–25.01) |
| TT77 biometric authentication | 2 | image-only notice (02.07) — biometric step for transactions |
| Bank fee e-invoices | 5 files / 6 invoices | see below |

Fee e-invoices (VND, VAT included):

| Invoice date | No. | Amount | Remark |
|---|---|---:|---|
| 26.01.2026 | 1K26TAB-00005935 | 22 000 | outgoing transfer: Cosmetic Product Notification invoice 21012026001 |
| 27.01.2026 | 1K26TBB-00028157 | 154 000 | internet banking maintenance fee |
| 27.01.2026 | 1K26TBB-00028158 | 38 500 | internet banking maintenance fee |
| 11.02.2026 | 1K26TAB-00011480 | 22 000 | outgoing transfer: accounting consulting 3 months, invoice 10022026 |
| 17.06.2026 | 1K26TAB-00038333 | 22 000 | outgoing transfer: 3 months consulting services |
| 30.06.2026 | 1K26TAB-00041068 | 22 000 | outgoing transfer: 2nd installment Cosmetic Product Notification |

Total fees seen: **280 500 VND**. Transfer amounts are not in the mails — they come from the statement.
The fee e-invoices are **not** registered as a `bank_statement_sources` sender: they are fee
documents, not statements, and would create false transactions.

## How the API connection would work

VietinBank's official route for companies is the **Open API Portal** — `openapi.vietinbank.vn`
(new version launched June 2026; older address `developer.vietinbank.vn` redirects there).
Public facts: online company registration and activation, sandbox, 19 products including
account inquiry, balance-change notification, domestic transfer, payroll, virtual accounts;
corporate hotline 1900 558 886. Endpoint specs sit behind the portal login and are **not on file**.

Steps, in order:

1. **Owner** registers DEASEAN on the portal (company identity + legal representative) and
   signs whatever service agreement the branch asks for. Relationship manager: Hana (VietinBank).
2. Ask for two products: **account inquiry / transaction history** (pull) and **balance-change
   notification** (push to our webhook).
3. Credentials go into `SECRETS/vietinbank-deasean.md` on both vaults (§0f-1), then as a Worker
   secret — never in this repo.
4. Build `api/src/routes/banks-vietinbank.ts` on the Modulbank pattern: webhook → `bank_transactions`
   (idempotent on `external_id`) + hourly pull as a drift check; set `bp_vietinbank.auth_method`,
   `api_base_url`, `webhook_path`, and `api_enabled = 1` per account.

Until step 1 happens, the path is statement upload in `/finance`.

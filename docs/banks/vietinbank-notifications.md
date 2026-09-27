# VietinBank notification quarantine

## Deployment and scope

Callback candidate: `https://dasoperator-api.dasexperten.workers.dev/webhooks/vietinbank/notify-bill` (POST).
Deployment must be verified against this endpoint before giving it to the bank.
This receiver stores authenticated notifications in `vietinbank_notification_inbox`.
It creates **no bank transactions, balances, payment instructions or ERP accounting entries**.
There is no inbox read route; raw financial PII is accessible only through administrative D1 access. Do not log bodies, credentials or database errors.

On 2026-09-27 authenticated portal project 366 still showed New Registration for all three services. Registration directed the owner to CN9 or Support; it did not expose self-service webhook activation. A reachable callback does not establish bank entitlement.

## Configuration (all absent/disabled by default)

- `VIETINBANK_NOTIFY_ENABLED`: explicit `true` only after acceptance below.
- `VIETINBANK_NOTIFY_PROFILE`: `RSA_PKCS1_SHA256_UTF8` only after bank fixture confirmation of padding and encoding. No SHA1 fallback.
- `VIETINBANK_NOTIFY_FIXTURE_REF`: reference to the reviewed bank UAT fixture/evidence, not its contents.
- `VIETINBANK_PROVIDER_ID`: bank-issued identifier.
- `VIETINBANK_BANK_PUBLIC_KEY_PEM`: trusted bank RSA2048 public key in SPKI PEM, delivered via agreed bank channel and fingerprint checked.
- `VIETINBANK_PARTNER_PRIVATE_KEY_PEM`: approved partner RSA2048 private key in PKCS8 PEM via vault/Worker secret; never in source or logs.
- Existing `DB` binding; migration `0104_vietinbank_notification_inbox.sql` must be applied before activation.

For an authenticated bank `.cer`, inspect its format and certificate fingerprint offline. PEM certificate: `openssl x509 -in bank.cer -pubkey -noout`; DER certificate adds `-inform DER`. This extracts SPKI, it neither generates keys nor establishes trust in the certificate. Verify the fingerprint out of band with bank onboarding. Use the normal secrets pathway to install values; don't paste them in shell history.

## Contract and boundaries

Source: [official notification API](https://openapi.vietinbank.vn/api/54418fc5-ee05-4683-8924-457d6ec8976f?product=03418e03-bb43-4c8c-bd11-be9e23fc8d20), v1.0.0, downloaded 2026-09-27; exact NotifyRequest schema and original download SHA256 are in `api/src/lib/vietinbank-notify-schema.mjs`.
PDF: `VietinBank_Thong bao bien dong so du_OpenAPI_Techspec_v1.0.pdf`, pages 6–14. RSA2048/SHA256 is stated; generic appendix also mentions SHA1, and padding/encoding need bank fixture confirmation. The implementation supports only the explicitly configured profile above.

Request signing text concatenates `transId + transTime + custCode + amount + bankTransId + remark`, skipping missing/empty optional fields, without whitespace/decimal/case normalization. Schema values must be strings. Response signing text is `transId + errorCode + errorDesc`; signatures use Base64.

Neither currency, account routing nor transType is covered by the documented signature. They remain untrusted raw data even after cryptographic verification. No financial mapping is permitted from this inbox. Statement debit/credit documentation also conflicts; this receiver does not resolve it.

Verified first delivery: durable insert plus readback, then signed `00`/Success. Identical payload retry: signed `05`/Duplicate transaction (documented duplicate-transId code). Full payload comparison includes unsigned fields; different data for the same provider/transId returns HTTP409 without overwriting. Object property ordering is immaterial; string values remain exact. The bank must confirm signed05 handling when its first ACK was lost. No financial side effect depends on retries.

Missing/invalid config: HTTP503 before body/DB access. Bad request: 400; bad signature: 401; oversized body: 413; DB/signing failure: 503, never unsigned success. These HTTP failures are transport failures, not invented bank response codes. Local resource bounds: 32KiB body and depth32, not asserted bank limits. Confirm bank production payloads fit them.

## Activation acceptance

1. Obtain approved notification entitlement, assigned provider ID, trusted bank certificate and agreed partner certificate exchange. Do not reuse eFAST credentials.
2. Bank confirms RSA2048, PKCS1-v1_5/SHA256, UTF8, exact signing fields, empty-field rules, retries, and signed05 handling. Validate real signed UAT fixture, including Vietnamese text and empty bankTransId.
3. Apply migration with the existing Apply D1 migration workflow. Configure secrets through vault procedure; keep enabled false until the fixture succeeds in an isolated UAT configuration.
4. Verify signature failure and storage failure yield no ACK; valid notification is durably quarantined and its response signature verifies with the partner public key. Test duplicate and conflicting retry. Confirm no financial table changes.
5. Register the verified callback through existing project onboarding; do not create a duplicate project. Record bank approval and delivery evidence before enabling production notifications.

Local tests: `node --test api/src/lib/vietinbank-notify.test.mjs` (Node24 for built-in SQLite). Keys are disposable in-memory test keys. Tests include real WebCrypto signatures, actual SQLite migration/unique constraint, concurrent retry, tampering, failed persistence, resource limits and key size. Production deploy uses existing Deploy Worker CI from main; do not deploy a local checkout.

Rollback: disable `VIETINBANK_NOTIFY_ENABLED`; retain quarantine evidence. Revert the receiver commit and redeploy main if code rollback is required. Do not drop the inbox as rollback.

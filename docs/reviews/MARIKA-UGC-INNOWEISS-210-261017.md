# INNOWEISS = 210

Owner clarification, 17 October 2026: bare INNOWEISS identifies product DE210. The legacy workbook spelling `InnoWeis` follows the same mapping. Explicit mouthwash references/code DE310 retain their identity.

- Parser updated for new imports and payout product references. Explicit import codes participate in resolution, so a bare name does not override a supplied DE310.
- Migration `0130_ugc_innoweiss_210.sql` applied from pushed main through GitHub Actions **39017219539**, successful. It changed **284 product source rows** and **135 publication-local classifications** from unknown to identified/manual. Original evidence is preserved with the Owner resolution appended. Other family labels are retained.
- No product was inherited from an account history into an unrelated publication. No financial amount/status was changed.
- Native Chrome verified Zalina's row: product **210**, current enabled brown payout **627 ₽**, followers **9361**. The product filter now shows `210 · 283` and retains `310 · 2`.
- Ten product/source tests pass. A SQLite migration fixture verifies exact mapping, preserved DE310, preserved unrelated labels/payment amounts, and idempotence.
- Main implementation `3e8f3989041ad340231c73b409069de130ba0654`: Worker **39017219672**, timer workers **39017219667** and Checks **39017219682**, all successful. Follow-up `640d10d6` strengthens explicit-code handling in future imports.

Proof screenshot: `/private/tmp/marika-ugc-innoweiss-210-261017.png` (kept local).

-- Owner 2026-10-16: «прежде чем коричневая кнопка будет, должно быть именно название продукта».
-- What the payout pays for (e.g. «TERMO + ETALON»); a payout without it is not payable.
ALTER TABLE ugc_payouts ADD COLUMN product TEXT;

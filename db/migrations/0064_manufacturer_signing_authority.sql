-- 0064: Manufacturers get their own document signatory.
-- LAW: CI / IS / PL are issued by the SELLER — the signature block must carry
-- the seller's representative. Factory-sellers therefore need signing
-- authority fields identical to companies. No fallback to the buyer's GM.
ALTER TABLE manufacturers ADD COLUMN signing_authority_name TEXT;
ALTER TABLE manufacturers ADD COLUMN signing_authority_title_en TEXT;
ALTER TABLE manufacturers ADD COLUMN signing_authority_title_ru TEXT;

-- Yangzhou Jinxia — confirmed signatory.
UPDATE manufacturers
SET signing_authority_name = 'Luis Guan',
    signing_authority_title_en = 'General Manager',
    signing_authority_title_ru = 'Генеральный директор'
WHERE name LIKE '%Jinxia%' OR legal_name_en LIKE '%JINXIA%' OR slug LIKE '%jinx%' OR slug LIKE '%yzjx%';

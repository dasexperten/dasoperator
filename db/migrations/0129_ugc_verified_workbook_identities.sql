-- Owner's full workbook reconciliation, 2026-10-16.
-- Public post owners and original rich hyperlinks establish these identities.
-- Existing ids remain stable; Sheet1:475 is split from the false shared "reel".
-- Proofs and source-row addresses: docs/UGC-FULL-WORKBOOK-AUDIT-2026-10-16.md.

UPDATE ugc_creator_platforms SET handle='ekaterina_ria',normalized_handle='ekaterina_ria',
  profile_url='https://www.instagram.com/ekaterina_ria/',updated_at=unixepoch()*1000
WHERE id='ugcp_4b5e95bae1f4331bae4a3b40' AND normalized_handle='reel';
UPDATE ugc_creators SET normalized_handle='ekaterina_ria',updated_at=unixepoch()*1000
WHERE id='ugc_4b5e95bae1f4331bae4a3b40' AND normalized_handle='reel';

UPDATE ugc_creator_platforms SET handle='pozdnyakovaylia',normalized_handle='pozdnyakovaylia',
  profile_url='https://www.instagram.com/pozdnyakovaylia/',updated_at=unixepoch()*1000
WHERE id='ugcp_1db2954eee967030ab3e36f4' AND normalized_handle='pozdnyakovaylia..';
UPDATE ugc_creators SET normalized_handle='pozdnyakovaylia',updated_at=unixepoch()*1000
WHERE id='ugc_1db2954eee967030ab3e36f4' AND normalized_handle='pozdnyakovaylia..';

UPDATE ugc_creator_platforms SET handle='galievagelnaziia',normalized_handle='galievagelnaziia',
  profile_url='https://www.instagram.com/galievagelnaziia/',updated_at=unixepoch()*1000
WHERE id='ugcp_9f4736018572490f899d533f' AND normalized_handle='cococannabis,mittel';
UPDATE ugc_creators SET normalized_handle='galievagelnaziia',updated_at=unixepoch()*1000
WHERE id='ugc_9f4736018572490f899d533f' AND normalized_handle='cococannabis,mittel';

INSERT OR IGNORE INTO ugc_creators
  (id,normalized_handle,lifecycle_stage,created_at,updated_at)
VALUES ('ugc_d150de5377b6a7f496b54307','mamavlada19.07','posted',unixepoch()*1000,unixepoch()*1000);
INSERT OR IGNORE INTO ugc_creator_platforms
  (id,creator_id,platform,handle,normalized_handle,profile_url,source,created_at,updated_at)
VALUES ('ugcp_d150de5377b6a7f496b54307','ugc_d150de5377b6a7f496b54307','instagram',
  'mamavlada19.07','mamavlada19.07','https://www.instagram.com/mamavlada19.07/',
  'Blooger Database.xlsx;verified_public_post_owner',unixepoch()*1000,unixepoch()*1000);

UPDATE ugc_content SET creator_id='ugc_d150de5377b6a7f496b54307',
  creator_platform_id='ugcp_d150de5377b6a7f496b54307',updated_at=unixepoch()*1000
WHERE source_workbook='Blooger Database.xlsx' AND source_sheet='Sheet1' AND source_row=475
  AND creator_platform_id='ugcp_4b5e95bae1f4331bae4a3b40';

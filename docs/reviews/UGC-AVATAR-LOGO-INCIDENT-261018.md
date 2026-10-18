# Incorrect Instagram avatars: incident and full correction

Owner reported anzhela.like on 18 October 2026, then required checking the remaining saved avatars and explaining why the error was missed.

## What failed

The old public-page fallback accepted og:image whenever its host was an allowed Instagram/Meta CDN. That CDN also serves Instagram branding and post previews. A generic Instagram logo was therefore stored as a creator avatar. Successful authenticated image reads and JPEG/PNG/WebP signatures only proved that files existed and decoded; they did not prove that those files were the requested person's profile photo. Earlier reports described this weaker check as avatar correctness and were wrong.

The complete initial saved-image audit covered 386 Instagram profile records across the active, inactive and archive views. 117 files were byte-identical to the Instagram logo observed in anzhela.like's ERP record. All 117 references were removed after checking their current bytes again; cached objects and reference backups were retained. anzhela.like was corrected from the exact signed-in profile photo before the full pass.

## Correction method

- All 386 original profile IDs were frozen; the audit did not redefine the cohort after hiding unavailable accounts.
- Every record received a fresh source check through the deployed guarded refresh. 296 supplied a verified source automatically. The remaining 90 received exact-profile checks in signed-in native Instagram.
- Public metadata must identify the requested handle. CDN URLs must use profile-picture paths; generic resources, post previews and observed default silhouettes are rejected. The confirmed logo's byte digest is rejected as a further regression guard.
- Native browser exceptions use the exact profile image, with its observed asset URL and downloaded source retained in a private artifact manifest. Incorrect images are not replaced with guessed portraits, post pictures or generated faces.
- Avatar cache keys now include a version so photo replacement is visible in an already open ERP session.
- An explicit profile correction can update a photo inside the archive without clearing its archive flag; scheduled batches continue to skip archived accounts.

All original metrics, payout, conversation and publication history were retained. No payout or Direct message was sent by this task. Newly confirmed unavailable pages use the existing Inactive view; a default silhouette alone is not account inactivity.

## Validation and evidence

Four focused parser regression tests pass. Frontend TypeScript passes; changed API modules have no TypeScript diagnostics (unrelated existing API diagnostics remain). The actual refresh SQL was exercised in SQLite to confirm default archive exclusion and explicit archived-profile correction.

Core fix merged in PR 195 at e389f22a86e69f9da3fa6858d89501bc5efdf70d; API run 39114911525 and Pages run 39114911530 succeeded. Explicit archive correction merged in PR 199 at 0aa17927133a78092bed3508c4f977c8cde6c7e7.

Private evidence is under .dasexperten/private-handoff: diana-full-avatar-audit-261018.json, diana-logo-cleared-backup-261018.json, diana-avatar-revalidation-261018.jsonl, diana-avatar-browser-proofs-261018.json, diana-avatar-browser-applied-261018.jsonl, and diana-avatar-final-audit-261018.json. Native asset manifests are under the browser-use temporary artifact directory. No credentials, signed image links or image payloads are committed.

## Final verified result

Final authenticated readback accounts for every original record: **386 checked; 362 photos with confirmed profile sources; 20 currently unavailable Instagram pages; four accessible profiles without a custom photo; zero unverified records and zero failed checks.** The known logo and cached default silhouette are absent from all 362 accepted image reads. Every manually restored photo with a downloaded native asset matched that asset's bytes exactly. 129 stored image byte sequences changed; that number includes resolution/compression or updated-photo changes and is not a claim that all 129 were previously wrong portraits.

The 20 newly confirmed unavailable pages were marked through the existing availability endpoint and are hidden by the default view. Default silhouettes were cleared without marking those accessible accounts inactive. Explicit archive correction run 39117101698 succeeded, and the confirmed archived photo was saved without restoring the creator to the active list.

Native production verification of anzhela.like showed the actual profile photo, with the pink box visible in the signed-in Instagram source, and the click enlargement decoded at 520 by 520 px. This replaces the previously cached Instagram logo. All 117 confirmed logo references were cleared and every original record subsequently received either a verified current photo or an observed reason for its absence.

# Articles production verification

Julian Farah, 16 October 2026.

Feature commit: `b8c72c4c97e6b208e1b7de8024d7162ddeec0f88`. All 14 changed files were read back through the GitHub Contents API and matched the committed bytes. Safe upstream failure telemetry followed in `eb2eb57bb4749bc17ddd62c0049eba7348a3aebc`.

The normal deployment guards passed, including the seven new article projection/route tests. Pages production deployment [38865819830](https://github.com/dasexperten/dasoperator/actions/runs/38865819830) and Worker deployment [38866120850](https://github.com/dasexperten/dasoperator/actions/runs/38866120850) completed successfully. No guard was bypassed and no local Worker deployment was used.

The first live article request returned a source error. A filtered Worker log established the cause: GitHub returned HTTP401 for the existing `ORG_SSOT_TOKEN` binding. The canonical existing Token1 from the GitHub vault read the private ledger successfully, and the same value was verified in both required vaults. The Worker binding was restored to that existing canonical credential. No token was created or rotated, and no credential value was logged or added to these records. The source tree was clean and identical to `origin/main` before the configuration repair.

After the repair, `GET https://dasoperator-api.dasexperten.workers.dev/api/analytics/articles` returned HTTP200 with 19 rows and exactly the requested five fields. The 16 October rows were Calameo DE, Flipboard EN, Teletype RU and Wakelet VN. The other rows are historical placements; 19 is not today's daily publication count. Drafts and the private TikTok record were absent.

The production Analytics HTML and its actual `app/analytics/page-4543a3e12799d55a.js` chunk returned HTTP200. The deployed chunk contains the new Articles endpoint and Placement service label. Native component acceptance at actual390/1440 frames is recorded in [Marika's review](MARIKA-ARTICLES-261016.md). Authenticated full production chrome verification is assigned to the root browser operator in this same run and is not claimed by these API and asset checks.

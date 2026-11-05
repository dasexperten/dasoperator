# Sheets → ERP handoff contract audit

Pinned source: dasexperten/dasoperator commit `16149d51389cbc4d625bbc8e26d766890e232c14`, fetched through authorized GitHub connector. Static source review only; no endpoint calls, database reads, credentials, personal records, or repository edits. This is not verification of production deployment or migration execution. User-confirmed boundary: preliminary comments/contact stay in the existing Google Sheet; transfer only after response **and deliberate substantive discussion**, then work in ERP. A reply alone is insufficient.

## Conclusion

The reviewed public UGC router has **no general creator-create or qualified-handoff endpoint**. No existing single endpoint safely transfers a new creator across platforms, captures the qualifying discussion evidence, resolves renamed/merged identity, and preserves manual decisions.

For an already-resolved existing creator, `POST /collaborations` can record actual discussion details with `status: "replied"`, notes and next action without changing creator lifecycle. This does not prove qualification or create a missing creator; the caller must establish substantive discussion separately. Do not claim agreement or supply accepted_at unless evidenced. Do not use payouts as a creator-creation workaround.

## Import and create contracts

[ugc.ts lines 631–767](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/routes/ugc.ts#L631-L767), blob `4b5d146e3dda20a6617189b20fd2b1780899768e`:
- `POST /import` accepts JSON `{rows: [...],}` with 1–30 sanitized rows. Missing/empty handle rows are rejected. Response is counts `accepted, rejected, statements`, not resolved creator/profile IDs.
- Rows accept handle/platform/display_name, metrics, content/product/usage fields and workbook/sheet/row provenance. They do **not** accept creator_id, profile_id, qualification evidence, lifecycle_stage, discussion notes, manual-decision version, or an idempotent handoff key.
- New Instagram creator rows get empty lifecycle stage. Existing creator conflict updates only display_name (non-null) and updated_at, preserving lifecycle. Instagram qualification is not enforced.
- Non-Instagram import first hashes normalized platform:handle, looks up that exact creator ID, and requires stage in `agreed, cart, paid, ordered, creation, posted, gold`. Missing creators and `replied` are rejected. Thus it cannot bootstrap a new non-Instagram qualified discussion, even when genuine.
- Creator/profile IDs are prefix plus first 24 SHA-256 hex characters of platform:handle. Profile upsert conflicts on (platform, normalized_handle), preserving the existing profile id and creator_id; importer nevertheless uses its computed IDs for content. Content upsert is keyed by workbook/sheet/row and can replace creator/profile links and multiple content fields.
- Import does not consult handle history, manual-stage records or purge markers. Its deterministic IDs are NOT a safe canonical identity resolver.
- The public router has no `POST /creators`. The payout-specific creator resolver can create a minimal `agreed` card ([lines 1046–1082](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/routes/ugc.ts#L1046-L1082)), but it is coupled to payout operations and must not manufacture agreement for migration.

## Existing-card writes and manual decisions

[PATCH contract, lines 769–824](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/routes/ugc.ts#L769-L824):
- `PATCH /creators/:id` requires a real existing creator, else 404. Supports display_name, category, audience_market/language, lifecycle_stage, priority, owner, notes, origin and archived. Undefined fields preserve the fetched value; supplied notes replace, not append. Does not accept accepted_at or handoff evidence.
- Allowed lifecycle stages: empty, replied, agreed, cart, paid, ordered, creation, posted, gold, silent, failed, fee, refused, unfit, rival, owner. No separate “substantive discussion” stage.
- There is no compare-and-swap/version check or manual-stage conflict guard. Even an omitted lifecycle_stage is written back from a preceding read; concurrent edits can be lost. Automation must not send lifecycle changes merely to satisfy import.
- `manual_edit: true` writes a manual-stage record only when stage actually changes. This flag denotes a human double-click, not automation. Record is latest `{from,to,by,at,reviewed_at:null}` at `manual_stage:<creator_id>`; it is not an append-only history.
- `POST /creators/:id/manual-stage/reviewed` reads the record and stamps reviewed_at; it neither changes stage nor accepts/stores the review conclusion. It also has no version/CAS precondition.
- [ugc-manual-stage.mjs](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/lib/ugc-manual-stage.mjs), blob `662cdbe84d5c6a3d9b342b9946a92f0a7f2c759c`, confirms that reviewed records still retain their human decision.

[POST /collaborations, lines 982–1033](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/routes/ugc.ts#L982-L1033):
- Requires creator_id and verifies existence. Optional id enables upsert; absent id generates a UUID. Existing fields are preserved when omitted. No lifecycle change or manual-stage write.
- Fields include status (default new, no enum validation), platform, contact_channel, invited_at, accepted_at, last_contact_at, next_action/at, offer_type, deliverables, product_codes, sample_status/sent_at, content_due_at, published_at, rights_scope/expires_at, owner, notes.
- Existing collaboration id ownership is **not** checked against supplied creator_id, and conflict update does not replace creator_id. Caller must use verified mapping and a correctly scoped collision-free id; response echoes the supplied creator_id even on such a mismatch. No concurrency/version guard or handoff uniqueness contract.

## Rename, merge and stable identity

[ugc-rename-check.ts](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/lib/ugc-rename-check.ts), blob `63910009d19336d83b41e277adb07e57daa72730`: confirmed rename updates handles **in place**, retaining creator and profile IDs, and writes ugc_handle_history. A claimed new handle belonging to another card becomes a conflict, not an automatic merge.

[Merge route, lines 124–158](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/routes/ugc.ts#L124-L158): explicit from_creator_id / into_creator_id transfers content, collaborations, source records and payouts to the target Instagram profile, records old handles, deletes old profiles and creator in a batch. Mixed-platform source is rejected. It does not explicitly remap old manual_stage state or move pre-existing old-profile handle-history rows; remaining FK references may block the batch (409). Source claims nothing changes on a blocked merge.

Consequences: hashing a new handle after rename may create an orphan/twin creator, while profile conflict keeps the old profile ID; content can reference a nonexistent computed profile. Importing an old handle can recreate a stale card. After merge, old deterministic creator IDs no longer identify the survivor. Store and resolve actual creator/profile IDs plus verified aliases, not just hashes. Same handles on different platforms are intentionally separate people unless explicitly linked.

## Purge and cleanup exclusions

[ugc-silent-purge.ts](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/lib/ugc-silent-purge.ts), blob `26c9f48329f25220ff1daf395f29ad536d695623`:
- Recurring selector: Instagram profile, creator stage empty/silent, creator created_at at least seven days old; batch 200. It does not measure seven days from first contact.
- Excludes any inbound IG message matching **current** profile handle; any payout, source record or content; any collaboration whose status is outside empty/found/silent. A genuine replied collaboration excludes purge even without forcing agreed.
- Does not explicitly exclude manual decisions, archived status, notes, or inbound messages only under historic aliases. Deletes history, collaborations, profiles and creator, retaining `ugc_purged:instagram:<handle>` marker with silent_7d reason.
- Such protection is not proof that transfer qualified. Do not invent collaboration statuses/content to evade cleanup.

[0152 cleanup](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/db/migrations/0152_ugc_shopee_cleanup.sql) blob `e47b477e3c1cf6f04f8aeded1868c332c67205e7`, and [0153 cleanup](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/db/migrations/0153_ugc_nondialogue_cleanup.sql) blob `12ae5ca5da6409a6143c4db8b1b0c4edf077bc22`: one-time selectors cover Shopee-only and then non-Instagram empty/silent creators, excluding payouts, source records and working collaborations; 0153 additionally excludes any IG message matching creator normalized_handle (without direction filter). Unlike recurring purge, existing content is NOT an exclusion and is deleted. Backup tables preserve creator/profile rows only, not all deleted dependent data. No conclusion here that these migrations ran.

## Existing internal route and mounts

[api/src/index.ts](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/index.ts), blob `29d02bd1b0e94ba1ade6a72f085d9ad25ddc0dc3`, mounts the public router at `/api/ugc` (line 349), so public paths above use that prefix; internal router is mounted at `/internal/ugc` (line 216). [internal-ugc.ts](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/routes/internal-ugc.ts), blob `abedf5211ccd2476225e49400a6853e5d3cfce15`, has only `POST /hard-answer`: guarded by a configured service secret and matching service-secret header, accepting finite numeric message_id and nonempty choice, delegating a pre-existing hard-question answer. It is not a general creator-create or handoff contract. Public write routes require a valid ERP session with UGC full/rw access (admin gets full). These are static guard semantics, not evidence that an authorized credential, deployed route, or working runtime is available. No access setup or route invocation was attempted.

## Required safe boundary

Keep unqualified rows in Sheet. For a qualified new non-Instagram creator, current public contract is blocked, not solved by relabeling as agreed. A future dedicated handoff needs explicit response + substantive-discussion evidence, actual canonical identity/alias resolution, stable source-row handoff key, transactional create/update and manual-decision/version conflict protection. Existing-card collaboration recording is a constrained partial option, not a complete handoff API. Authorization implementation and access setup are outside this source audit.

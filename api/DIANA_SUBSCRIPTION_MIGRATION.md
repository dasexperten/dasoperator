# Diana native subscription inference

Owner decision2026-10-29: image checks use `gpt-6-luna`, then `gpt-6.1-terra` on transport/schema failure or unresolved required facts. No invented confidence threshold. Context selection uses native Luna with structured scores for every candidate. Neither operation has an OpenRouter fallback.

## Runtime

`api/subscription-runner` runs unmodified Codex CLI0.165.0 in a Cloudflare Container, using a separately authorized ChatGPT login. One Durable Object serializes all requests and native credential refresh. Auth is encrypted using AES-256-GCM in durable storage; decrypted auth reaches only the private container and is removed from caller responses. API keys, shell, apps, plugins and web search are disabled for extraction. Native request files are deleted after each run. Matching request IDs reuse successful results; mismatched bodies reject. Timeout escalates SIGTERM to SIGKILL, leaving caller work pending.

The main API uses the named `InferenceService` binding. Public bootstrap/smoke endpoints require ADMIN_KEY; missing keys deny. ADMIN_KEY, AUTH_KEY and scoped CI deployment credentials are recorded and read back in both private vaults. Native rotating credentials are exclusive to the encrypted singleton store.

Model receipts identify the explicit native CLI model argument; the JSONL protocol does not independently return a server model ID. Local and Linux native probes confirmed both requested model access and Luna inference. This is not a claim about token billing per call.

## Evidence semantics

- Brand or logo never establishes the marketplace seller. Unknown explicit seller stays unknown.
- Ozon basket seller exemption remains unchanged.
- Definite product/seller mismatch and an understood unrelated image do not trigger Terra.
- Missing required fields, invalid output, unknown kind and service failures trigger Terra; reasons are recorded.
- Both service calls failing means retryable infrastructure pending, not “photo unreadable”.
- Remaining uncertainty stays unknown. Earlier images cannot supply missing facts for the latest image.
- Source-labelled internal extraction retains programme product, price, currency, marketplace payment/delivery wording and exact visible text/requisites for text generation. These sensitive fields must not be printed in reports or diagnostic logs. A marketplace payment badge never proves our reimbursement.
- Reply generation receives the extracted evidence, not image bytes. Existing order milestones, Owner payout approval, delivery windows and card policies remain unchanged.

Source commit SHAs and whole selected skill/entry bodies remain in context receipts. Candidate descriptions are no longer cut to400characters.

## Validation and rollout

Unit tests cover all-candidate completeness, schema rejection, fallback semantics, brand versus seller, latest-image evidence, unchanged image bytes, private subscription receipts, native auth refresh and ignored SIGTERM cleanup. Integration tests cover pending outages and exclusion of image bytes from reply generation.

Native Mac probe on one real order screenshot: Luna got prices429/142 and paid/assembly right, but missed kind and inferred brand as seller. Terra on the same image correctly returned order and seller unknown. One example is not a comparative benchmark.

Rollout is staged: deploy and smoke-test the runner, then activate the API binding and audited context/image paths from verified main. No creator messages are sent by smoke tests.

References:
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/auth/ci-cd-auth
- https://developers.cloudflare.com/containers/get-started/
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/models/gpt-6.1-terra

### Verified cloud smoke2026-10-29

Actual container image3103c7b1… reached rollout `completed`, healthy1, before verification. A previous Worker-success result had preceded image readiness and produced503; the deployment workflow now waits for image rollout completion.

Native cloud Luna returned structured JSON successfully in8.8s. Full source-pinned context preparation completed in40.8s using4Luna requests, loading6whole skills,19entries and2references. Source revisions: organizacia `b12eb21cf2bbc30fac17f135f79c2c4427ec8107`; skills `c444313ca328cd78a1990b14814d240c882c1eaa`.

The real order fixture then used Luna12s → Terra9s. Both recognized the programme product and429RUB; the missing seller remained unknown, with overall check unknown. No personal fields are included in this report. These smoke requests did not send any creator message or initiate a payment.

The existing scheduled path awaits the ERP service response and renews its lane lease. Because Cloudflare Cron has a15-minute wall limit, the reply batch stops admitting new conversations after7minutes, preserving an8-minute reserve. Deferred items remain unhandled, are counted as waiting work, and resume on the3-minute adaptive tick. This is a batch admission bound, not a claim that any arbitrary single inference can never time out.

### Production integration verified

API main `6077f6779927e03c00f951db332b4b17e990ede2` deployed through successful CI40932434261. The protected read-only ERP `diana-context-check` returned HTTP200, ok=true in58.99s: subscription context loaded5whole skills,14entries and3references; org revision `58e17c51a000cea867f08933d390fed1a20295f5`, skills revision `c444313ca328cd78a1990b14814d240c882c1eaa`. Its image fixture was correctly classified as other by native subscription Luna, with no unnecessary Terra escalation. This verifies the production service binding, not just an isolated runner. No creator message or payment was initiated. GitHub Contents API verified25changed files byte-for-byte at the deployed source revision.

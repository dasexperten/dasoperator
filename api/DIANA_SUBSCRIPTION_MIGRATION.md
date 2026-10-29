# Diana subscription migration — preparation, not activation

Owner requested subscription inference for context selection and image checking.
Production is unchanged until a native subscription service passes Cloudflare smoke tests.
Do not treat the existing raw Anthropic OAuth Messages bridge as a native CLI service.

Prepared modules (not imported by production):
- `diana-subscription-selection.mjs`: scores every candidate in batches of128; validates complete, unique IDs and numeric0..1 scores; never truncates input; no provider fallback.
- `diana-subscription-transport.mjs`: service binding contract, forwards complete messages/images, checks matching operation/request/model receipt; never calls OpenRouter.

The receipt is a contract with the trusted service, not cryptographic proof of billing.
The native runner must enforce subscription authentication and exclude API-key and gateway fallback itself.

## Verified2026-10-29

Native Claude Code2.1.312 reports first-party claude.ai Max authentication. A restricted tools-disabled, no-session-persistence vision invocation with alias `sonnet` used `claude-sonnet-5-5`.
One real Ozon order screenshot correctly yielded TERMO39°,429 RUB, paid, assembling/delivery tomorrow; separated the other142 RUB item, returned unknown seller, and did not infer company reimbursement.
This is one image/order type, not a comparison against Terra or Luna and not a production cloud smoke.
CLI list-price equivalent usage metadata must not be represented as an actual separate subscription charge.

Cloudflare Containers applications API returned200 with an officially provisioned short-lived Containers Read token; applications list was empty. Token immediately revoked successfully. Earlier403 responses from deployment tokens indicated missing scope, not absence of Containers support.

## Remaining before activation

1. Official `claude setup-token` provisioning for native headless use; do not transplant cached login credentials or imitate Claude Code HTTP headers.
2. Deploy native CLI runner in Cloudflare Sandbox/Containers, secure service binding, bounded lifecycle, isolated requests, image input and structured output, no API billing fallback.
3. Verify native subscription auth and model in Cloudflare with read-only fixtures, preserve image receipt semantics, source SHAs and every selection candidate.
4. Integrate both ERP paths, update tests, publish verified main, deploy identical main, read-only production smoke. No creator messages.

References:
- https://code.claude.com/docs/en/authentication
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://developers.cloudflare.com/sandbox/coding-agents/claude-code/

The Cloudflare guide's AI Gateway authentication is separately billed API access; it supplies container lifecycle guidance only, not subscription authorization.

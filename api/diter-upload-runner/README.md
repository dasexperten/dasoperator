# Dieter-only cloud runtime

Service `diter-upload-runner`, RPC entrypoint `DieterExecutionService`, singleton container `DieterRunner`. Only `dieter_round` on `gpt-6.1-terra` is accepted. No Diana Direct implementation, queue or scheduling.

Codex CLI uses a custom HTTP Responses provider at the fixed organizational Dieter door. Only `SUBSCRIPTION_DOOR_KEY` is provisioned here; OAuth remains in the single organizational holder. CLI request/stream retries are zero. See official [custom Responses provider contract](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

Public routes require `ADMIN_KEY`; wrong/missing auth is 404. GET `/runtime-check` invokes fixed synthetic tools only, zero models. Private RPC `/contract` and `dieter_round` use the existing ERP service boundary. Preflight runs an actual Codex shell tool check, archives closed event types privately, and verifies Drive permissions without publishing.

Before rollout retain Dieter stop. Rollback: remove ERP binding/disable Dieter cloud, preserving this Worker, DO and audit state; revert source through pushed main. Do not delete namespaces or restore Diana. Never seed desktop OAuth here.

A disconnected response does not cancel the accepted child. Exact cached results may be read up to three times per request across retries. Durable intent prevents native replay; absent cached completion remains unknown. Container-memory completion cannot survive container replacement, so it never proves non-execution.

# WB chat and Ozon chat

The `/reviews` page has separate read-only WB and Ozon conversation sections.
They display received customer messages, recorded Tamara replies and delivery
statuses from `care_chat_*` tables. An empty ERP list does not establish that the
marketplace inbox is empty. The last successful sync and latest failure/running
state remain visible so incomplete coverage is explicit.

`GET /api/marketplace-chats?channel=wb|ozon` supports bound search and pagination.
`GET /api/marketplace-chats/:id` paginates received messages and returns recorded
replies. Both routes require an active ERP session and `/reviews` read access
(or admin role), disable caching, and exclude marketplace reply credentials.
These routes neither generate nor send replies.

Validation: Next production build; SQLite-backed route checks for authentication,
permissions, channel isolation, bound search, pagination, private-field exclusion,
ready-versus-sent status and unavailable data. Full API TypeScript checking has
an existing repository-wide error baseline; the added route has no diagnostics.

Deployment is through the existing main-branch Worker and Pages CI workflows.
Rollback: revert the commit adding these sections and push main to redeploy both
surfaces. No database migration or customer-message mutation is involved.

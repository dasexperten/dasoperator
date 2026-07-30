# Emailer UI — Agents + Departments (Owner 2026-07-17)

**Surface:** ERP `https://erp.dasexperten.com/emailer`  
**Repo:** `dasexperten/dasoperator`  
**Code SSOT:**

| Layer | Path |
|---|---|
| Registry (API) | `api/src/lib/mailbox-registry.ts` |
| Registry (UI) | `web/components/emailer/mailbox-registry.ts` |
| Mail client | `web/components/emailer/mail-app.tsx` |
| Styles | `web/styles/das-design-tokens.css` (`.dxmail`) |
| Inbound | `api/src/lib/email-inbound.ts` → R2 `self-learning` `Inbox/` |
| Archive API | `api/src/routes/email-archive.ts` |

---

## 1. Navigation model

```
/emailer
├── Folders (Входящие / Важные / Отправленные / …)
├── Agents          ← accordion of rostered agents (avatars required)
│     └─ click agent → threads for that @ mailbox (Gmail-style)
└── Departments     ← functional mailboxes (NOT called "pipes")
      └─ eurasia@, orders@, marketing@, hello@, asean@, emea@
         (sales@, support@ and partnerships@ moved to Agents on 2026-07-30 —
          they have named owners now, see §9)
```

### Hard UI rules

1. **No "Pipes"** — use the label **Departments**.
2. **No `dr.badalyan@` in Agents** — Owner personal mail is not an agent folder. It is obvious it is the Owner.
3. **Agent avatars** — whenever a row/folder is a named agent (from or mailbox), show small circular portrait from  
   `https://www.dasexperten.com/assets/agents/{slug}.png` (40–48px). Do not invent faces if CDN 404.  
   **Masters SSOT:** `dasexperten/organizacia` → `avatars/{slug}.png`.  
   **Publish:** `dasexperten.com` repo `tools/publish_agent_avatars.py` → `site/com/assets/agents/` → Cloudflare Pages project `dasexperten-com` (direct upload; push alone does not deploy).  
   **Mina slug:** CDN canonical = `mina-rutunya.png` (+ alias `mina.png`). Emailer registry uses `mina-rutunya`.
4. **Threads** — list is grouped by counterparty; open thread = back-and-forth (received + sent) for that contact on the selected mailbox.
5. **Empty mailboxes stay visible** — 0 messages, not hidden.
6. **Resizable list | preview** — desktop: drag the vertical splitter between the message list and the message detail pane left/right; width persisted in `localStorage`.

---

## 2. Owner personal mail (`dr.badalyan@`)

| Rule | Detail |
|---|---|
| Address | `dr.badalyan@dasexperten.com` |
| CF Email Routing | **forward** → `dasexperten@gmail.com` (live rule name: `dr.badalyan → dasexperten@gmail.com`) |
| R2 / Worker archive | **No** — Owner reads in Gmail only |
| ERP `/emailer` | **Not listed** under Agents or Departments |
| Outbound From | Only when Owner explicitly signs as himself (emailer skill) |

Destination address on Cloudflare account is verified: `dasexperten@gmail.com`.

---

## 3. Storage (not separate sites)

- One domain MX: `dasexperten.com` → Cloudflare Email Routing.
- One archive bucket: R2 `self-learning`, keys `Inbox/<address>/received|sent/…`.
- One UI: `/emailer`.
- Avatars live on the marketing site CDN — not inside each R2 JSON.

---

## 4. Inbound matrix (summary)

| Kind | Examples | Routing action | UI section |
|---|---|---|---|
| Agent | `lauda@`, `roberta@`, … | Worker `dasoperator-api` | **Agents** |
| Department | `sales@`, `partnerships@`, … | Worker | **Departments** |
| Owner | `dr.badalyan@` | **Forward Gmail** | *(hidden)* |
| Catch-all | other locals | Worker | appears only if archive has data |

---

## 5. Desktop layout — resizable panes + ERP nav collapse

### Mail panes (inside `/emailer`)

```
[ Mail folders |  List  ‹drag›  Detail preview ]
```

- Default list width: **372px** (mockup).
- Min list: **280px**, max: **min(720px, ~55% of main row)**.
- Handle class: `.dxmail .pane-splitter`.
- Persist: `localStorage` key `dx_mail_list_width_v1`.

### ERP left sidebar (app chrome)

On `/emailer` desktop, header button **«Скрыть меню» / «Меню»** collapses the **Das Operator** left nav (`aside.dx-sidebar`) so mail can use full width.

| | |
|---|---|
| Control | Header toggle (PanelLeftClose / PanelLeftOpen) |
| Scope | **Only while** pathname is `/emailer` — other ERP pages always show full nav |
| Persist | `localStorage` `dx_emailer_erp_nav_collapsed_v1` (`1` = collapsed) |
| CSS | `aside.dx-sidebar[data-desktop-collapsed="true"]` |
| Mobile | N/A (drawer hamburger already) |

Mobile keeps single-column swipe UI (no mail splitter; no ERP collapse control).

---

## 6. Related product decisions (this session)

- Resend dashboard = **send** only unless Resend Receiving is enabled separately (MX conflict with CF).
- Inbound SSOT for ERP = CF Routing → Worker → R2 → `/emailer`.
- Agent avatars hard rule aligns with organizacia `docs/AGENT_AVATARS.md`.

---

## 7. Changelog

| Date | Change |
|---|---|
| 2026-07-17 | Agents + Departments nav; exclude Owner from UI; `dr.badalyan` → Gmail forward documented; resizable list/detail splitter |
| 2026-07-17 | Desktop: toggle collapse ERP left sidebar on `/emailer` for more reading space |

---

## 9. Agent mail — 2026-07-30

Owner gave every agent one mailbox and required the workers to **send**, not only read and draft.
The fleet side lives in `dasexperten/organizacia` → `docs/FLEET_MAIL.md`; this section records
what belongs to **this** repo.

### 9.1 The two registries move together

`api/src/lib/mailbox-registry.ts` and `web/components/emailer/mailbox-registry.ts` hold the same
map and are **separate files**. The API copy builds `HUMAN_SENDERS` — the allow-list that decides
whether Resend accepts a `from`. On 2026-07-30 only the web copy was updated for the new roster,
so eight agent boxes (`wb@`, `ozon@`, `brand@`, `legal@`, `hr@`, `finance@`, `vetrova@`,
`logistics@`) silently could not send: every attempt came back *from not allowed for brand Resend*.

**Change both in the same commit.** Retired personal addresses stay as `aliases` so historical
letters still resolve to their agent.

### 9.2 Who drafts the reply

| Route | Who writes | Signs as |
|---|---|---|
| `POST /api/email-tasks/agent-draft` | the agent's own Worker | that agent |
| `POST /api/email-tasks/draft` | the shared service in `lib/email-draft.ts` | **the Owner** |

The shared service names the Owner as the author in its system prompt, as a constant, for every
mailbox. That is why a reply composed from Lauda's `sales@` went out signed *Aram Valeri Badalyan*.
The Emailer button now calls `/agent-draft`; `/draft` stays mounted for non-agent mailboxes and
must not be pointed back at an agent box.

Both routes required a session as of 2026-07-30 — `/draft` had **none** and answered 200 to anyone
while spending a model call.

### 9.3 Reaching a seat

`/agent-draft` resolves the mailbox from the archive key through `MAILBOX_REGISTRY` (aliases
included) and calls that seat through a **service binding** in `api/wrangler.toml`
(`LAUDA_COMMERCE`, `TAMARA_HAAR`, … sixteen in total).

A same-account `*.workers.dev` subrequest from one Worker to another **is not routed** — it comes
back 404. The comment above the `SELF` binding records forty hours of silent marketplace-sync
failure from exactly this in May 2026; the first agent send hit it again on 2026-07-30. Never call
a sibling Worker by hostname.

The seats' own `/mail/*` routes require the service secret, so the browser cannot reach a seat
directly. The browser only ever talks to this API.

### 9.4 Sending

Seats send through `POST /api/email/resend-send` — Resend, plus the full letter filed into Emailer
Sent in the same call, so nothing an agent sends is invisible. `origin` is hardcoded `'human'`
there; the agent is identifiable only by `trigger` (`agent-reply:<slug>`), which the UI does not
surface. **A letter written by an agent is not visually distinguishable from one written by the
Owner.**

### 9.5 Inbound attachments

`email-inbound.ts` parsed the message and kept only `text`/`html`; `parsed.attachments` was read
nowhere in the repo, so every inline logo and attached image was discarded at the door — the
Emailer had nothing to render. Since 2026-07-30 the bytes go to their own R2 objects beside the
record:

```
Inbox/<addr>/<direction>/<recordId>/att/<n>-<filename>
```

and the record keeps metadata only (base64 in the record would ride along in every index read).
Caps: 20 files, 10 MB each, 20 MB total — over the cap the file is skipped and its metadata kept
as a receipt, so a missing attachment is visible rather than silent.

On read, `cid:` references are swapped for `data:` URIs (images only, 3 MB budget). The viewer is
a sandboxed `srcDoc` iframe with no same-origin access and cannot fetch an authenticated
attachment URL, so inlining is the only route that works there — and it adds no public door.

**Letters received before 2026-07-30 have no attachments stored and cannot be repaired.**
Attached (non-inline) images are stored but there is still no attachment strip in the UI.

### 9.6 The stub guard

`isThinOrStubText()` (under 40 chars, or a known backfill placeholder) was written to keep
placeholder bodies out of the archive but sat on the **live send** path, so no reply shorter than
40 characters could be sent at all — and it ran a second time *after* Resend accepted, reporting
failure on a letter already delivered. Split:

* `isPlaceholderText()` — empty or placeholder. Gates the live send. Length plays no part.
* `isThinOrStubText()` — kept, but only on the `archive_only` backfill path, where a thin body
  means hydrate from Resend.

### 9.7 Known scars in this repo — not fixed

* `api` carries **389 pre-existing TypeScript errors**; there is no typecheck in CI, so an API
  change ships blind. Verify with `npx tsc --noEmit` and grep for your own files.
* `Checks` fails on **duplicate migration numbering** and has been red for many commits. The
  pipeline shows red regardless of what you push, which is how nobody reads it.
* **Two workflows** deploy on one push to `api/**`, producing two deployments seconds apart.
* CI success is not proof: on 2026-07-29 the domain served a cached page over a fresh deploy, and
  a Pages deploy reported success while the edge still answered from the previous build. Verify
  against the live artifact.

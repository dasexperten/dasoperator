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
      └─ sales@, support@, eurasia@, partnerships@, …
```

### Hard UI rules

1. **No "Pipes"** — use the label **Departments**.
2. **No `dr.badalyan@` in Agents** — Owner personal mail is not an agent folder. It is obvious it is the Owner.
3. **Agent avatars** — whenever a row/folder is a named agent (from or mailbox), show small circular portrait from  
   `https://www.dasexperten.com/assets/agents/{slug}.png` (40–48px). Do not invent faces if CDN 404.
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

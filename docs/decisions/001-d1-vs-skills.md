# ADR 001 — D1 vs Skills as Source of Truth

**Status:** Accepted
**Date:** 2026-05-02
**Decision maker:** Aram Badalyan

## Context

Das Operator ERP needs to integrate with eight Das Experten skills
(product-skill, contacts, pricer, invoicer, legalizer, logist, emailer,
apifier). These skills already store reference data in markdown files
(contacts/reference/buyers/*.md, product-skill/references/*).

The question: where does operational data live — in D1, in skill files,
or both?

## Decision

Hybrid model (Variant Z):

- **D1 holds operational master data:** companies, manufacturers, partners,
  products, price types, product prices, warehouses, shippers, stocks,
  operations, line items, documents, inventory sessions, inventory items,
  sequences, FX rates.

- **Skills hold knowledge layer:** clinical data, ingredient INCI lists,
  contract templates, brand voice rules, sales playbooks, sanctions check
  results.

- **Reference data is synchronized daily** from skill markdown files into
  D1 by a background worker running at 03:00 UTC. Critical changes
  (banking details, legal names) trigger an alert via emailer to Aram.

- **PDFs and binary documents live in R2**, never in D1. D1 stores only
  the URL reference.

## Consequences

Positive:
- Native SQL JOINs across operational tables
- Fast aggregation queries for dashboards
- Single source of truth for operational state
- Skills remain authoritative for their knowledge domains
- ERP UI can edit data directly without breaking skill behavior in chat

Negative:
- Two storage layers must be kept in sync (skill files vs D1)
- Daily sync window means skill edits in chat are visible in ERP UI
  with up to 24h delay
- Sync conflicts require manual resolution if same record edited in
  both places between sync runs

## Alternatives rejected

Variant X (skills as source of truth, D1 as cache): rejected because
SQL aggregation for dashboards becomes prohibitively slow with cache
invalidation overhead.

Variant Y (D1 as sole source of truth, skills read from D1): rejected
because skill markdown files have value for Claude chat workflows where
no D1 access is available, and converting skills to query D1 breaks
their portability.

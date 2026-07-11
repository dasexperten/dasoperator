# Authority metrics — verified readings, 2026-07-11

Purpose: dated, source-linked snapshot of independently verifiable authority
metrics for dasexperten.com. Created after an audit found the AI Visibility
dashboard's authority figures (26/100 etc.) had no recorded source — see PR #132.

## Verified today

| Metric | Value | Source (public, re-checkable) | Fetched |
|---|---|---|---|
| Yandex SQI (ИКС, Site Quality Index) | **10** | https://webmaster.yandex.ru/siteinfo/?site=dasexperten.com | 2026-07-11, HTTP 200, `"achievements":[{"sqi":10,"valueType":"numeric","type":"SQI"}]`, `"hostName":"dasexperten.com"` |

Notes: Yandex SQI is Yandex's public domain-quality score (open-ended scale,
not 0–100). It is the only authority-class metric currently retrievable
programmatically without an account.

## Checked and unavailable without credentials

| Provider | Metric | Status 2026-07-11 |
|---|---|---|
| Moz | Domain Authority (0–100) | `api.moz.com` reachable, requires token; free tier exists (needs Moz account). No key in SECRETS. |
| Open PageRank (domcop) | Open PageRank (0–10, Common Crawl link graph) | API live, returns "Invalid API key" without key; free key on signup. No key in SECRETS. |
| Ahrefs | Domain Rating | Free web checker is captcha-gated; API is paid. |
| Semrush | Authority Score | Public `/website/<domain>/overview/` returns 404 for this domain (not in directory); API paid. |
| Wix SEO&GEO panel | "site authority" (Semrush-powered widget) | Dashboard-UI only, no API; owner declared it not a reliable source (2026-07-11). |

## Rule

Any authority number displayed in dasoperator must trace to a row in a dated
snapshot like this one (with source URL + fetch evidence) or to a live API
feed. Numbers without such provenance must not be rendered as data.

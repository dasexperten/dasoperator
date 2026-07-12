# Authority metrics — verified readings, 2026-07-11

Purpose: dated, source-linked snapshot of independently verifiable authority
metrics for dasexperten.com. Created after an audit found the AI Visibility
dashboard's authority figures (26/100 etc.) had no recorded source — see PR #132.

## Verified

| Metric | Value | Source (public, re-checkable) | Fetched |
|---|---|---|---|
| Yandex SQI (ИКС, Site Quality Index) | **10** | https://webmaster.yandex.ru/siteinfo/?site=dasexperten.com | 2026-07-11, HTTP 200, `"achievements":[{"sqi":10,"valueType":"numeric","type":"SQI"}]`, `"hostName":"dasexperten.com"` |
| Cloudflare Radar rank (traffic popularity, 1.1.1.1 resolver data) | **outside top 200,000** (`bucket ">200000"`, no numeric rank), data date 2026-07-06 | `GET api.cloudflare.com/client/v4/radar/ranking/domain/dasexperten.com` (Bearer CF Cloud Master) | 2026-07-12 |
| Tranco rank (academic top-list) | **not ranked** (`{"ranks": []}`) | https://tranco-list.eu/api/ranks/domain/dasexperten.com | 2026-07-12 |

Notes:
- Yandex SQI is Yandex's public domain-quality score (open-ended scale, not
  0–100). Value 10 = low/young domain.
- Cloudflare Radar and Tranco are traffic/popularity rankings, not link-graph
  "authority" scores, but they are the authority-class signals retrievable
  without a paid account, and both agree the domain is small (outside top 200k;
  not in the academic top-list). dasexperten.de returns the same Radar bucket.
- No true 0–100 "Domain Authority" (Moz) or "Domain Rating" (Ahrefs) could be
  fetched — see below.

## Checked and unavailable without credentials

| Provider | Metric | Status 2026-07-11 |
|---|---|---|
| Moz | Domain Authority (0–100) | `api.moz.com` reachable, requires token; free tier exists (needs Moz account). No key in SECRETS. |
| Open PageRank | Open PageRank (0–10, Common Crawl link graph) | Moved 2026 to openpagerank.keywordseverywhere.com (old domcop signups closed). New free tier = 30k domains/mo but API key needs a Keywords Everywhere login. Free no-signup web checker + Top-10M lookup are both reCAPTCHA-v3-gated and reject this datacenter IP ("reCAPTCHA check failed" / "request looks automated"). No key in SECRETS. |
| Ahrefs | Domain Rating | Free web checker is captcha-gated; API is paid. |
| Semrush | Authority Score | Public `/website/<domain>/overview/` returns 404 for this domain (not in directory); API paid. |
| Wix SEO&GEO panel | "site authority" (Semrush-powered widget) | Dashboard-UI only, no API; owner declared it not a reliable source (2026-07-11). |

## Rule

Any authority number displayed in dasoperator must trace to a row in a dated
snapshot like this one (with source URL + fetch evidence) or to a live API
feed. Numbers without such provenance must not be rendered as data.

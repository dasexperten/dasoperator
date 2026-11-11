# Diana vision acceptance set

Purpose: prove the screenshot reader reads a real Russian Ozon/Wildberries basket correctly (product, seller, amount), not just that the pipe is open.

- Images are real creator screenshots, kept outside git (private data). Never synthetic.
- `cases.json`: `[{"file":"01.png","kind":"basket","product":"yes","seller":"yes","price_minor":39400,"currency":"RUB"}]`, labelled by a person from the original DM.
- Run `runAcceptance({dir,cases,infer})` (src/lib/diana-vision-acceptance.mjs) with the production LLM gateway as `infer`.
- Pass bar: every case matches; `wrongConfident` must be 0 (a wrong amount stated with confidence is the failure that costs money).
- Target size: 15–20 cases: several baskets per marketplace, an unclear seller, a cropped price, a multi-basket case, a non-basket image.

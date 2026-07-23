# Planner — structural law (main)

**Status:** **on `main`** (not a side experiment)  
**First ship:** `e791adc` (2026-07-23)  
**UI:** https://erp.dasexperten.com/planner  
**API:** `GET /api/planner/summary` · `GET /api/planner/suggestions`  
**Code:** `api/src/routes/planner.ts` · `web/app/planner/page.tsx`

Owner (2026-07-23): packing fungibility + Russia stock zone are **structural** procurement rules. They live on **GitHub `main`** and in live ERP.

---

## 1 · Family pack fungibility (1 ↔ 2 ↔ 4)

| Rule | Detail |
|---|---|
| **Problem** | Separate SKU math for 1-pack / AA / AAAA ordered multipacks from factory while singles (or other packs) could cover via warehouse pack/unpack |
| **Family** | `de201` · `de201aa` (×2) · `de201aaaa` (×4) — same physical product |
| **Math** | Work in **physical pieces**. Pack: pieces ÷ pack_size. Unpack: pieces × pack_size (2-pack → singles doubles count; 4-pack → ×4) |
| **Where convert is allowed** | Bundlable warehouses only: **LBR · SRN · FLP** (not Ozon/WB FBO) |
| **Order** | Factory `suggested_order` = gap **after** convert. Do not order AA if free singles close the AA hole |
| **Default** | Bundling **ON**. `?bundling=0` restores old isolated-SKU plan for comparison |
| **Toothpaste** | Still unit-rollup to base (factory ships paste units); pack-level convert is for brushes/floss/other multipack rows |

### Examples (accepted)

- Free singles cover AA demand: 1800 singles → **900** AA (÷2), factory AA = 0  
- Free AA cover singles demand: 450 AA → **900** singles (×2), factory 1 = 0  
- Free singles cover AAAA: 2000 singles → **500** AAAA (÷4)

---

## 2 · Stock zone Russia vs Worldwide

| Button | Counts as cover |
|---|---|
| **Russia** | On-hand only where `warehouses.country = 'Russia'`. In-transit only purchases with **destination** warehouse in Russia |
| **Worldwide** | Broader non-factory pool (excludes factory GZH/YZH and virtual OTW) |

**Never under Russia:** China DGN/GZH/YZH, Vietnam SWH, virtual OTW stock as if already in Russia.

---

## 3 · Done criterion

| Layer | Proof |
|---|---|
| GitHub | Tip of **`main`** contains `applyPackFungibility` + `w.country = 'Russia'` |
| Live API | `rules.bundling_enabled` + `bundlable_warehouses` on summary/suggestions |
| Live UI | Bundling On/Off · column **From bundle** · Russia/Worldwide stock toggle |

Chat-only agreement without `main` = **not done**.

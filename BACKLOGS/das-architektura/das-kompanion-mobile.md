# 2026-06-19_session-mimo-ozon-marketing-das-kompanion-mobile

## Session Summary
Long session covering MiMo model config, Ozon marketing strategy, Das-Kompanion chatbot development, and comprehensive mobile responsiveness for ERP + dasexperten.de.

## Topics Covered

### 1. MiMo Code Model Configuration
- **Issue**: User wanted free mimo-auto model with auto-switch to paid when quota runs out
- **Action**: Created fallback script `mimo-fallback.sh` + launchd agent `com.dasexperten.mimo-fallback`
- **Result**: Switched to mimo-auto, fallback script monitors quota every 5 minutes
- **Status**: ✅ Done

### 2. Ozon Marketing Ideas
- **Context**: Analyzed 184 campaigns, identified winners (DETOX paste 5.2% DRR, floss 5.8%, KRAFTBURSTE 6%) and bleeders (ZERO 360 70.3% DRR)
- **Ideas presented**:
  - A) Bundles from winning SKUs
  - B) Video banners (free)
  - C) Cut bleeding campaigns, reallocate budget
  - D) Coupons on winners
  - E) Brand shelf
- **Status**: 💡 Ideas presented, no implementation yet

### 3. Das-Kompanion Chatbot (Major Feature)
- **Request**: AI chatbot on ERP home page for database navigation
- **Architecture**:
  - Backend: `/api/chat` endpoint on dasoperator-api Worker
  - Frontend: Chat widget component
  - LLM: DeepSeek V4-Pro via direct API call
  - Security: Permission-checked queries, session validation
- **Files created**:
  - `api/src/routes/chat.ts` — Backend API
  - `web/components/das-kompanion/das-kompanion.tsx` — Frontend widget
  - `web/components/das-kompanion/das-kompanion-wrapper.tsx` — Layout wrapper
- **Features**:
  - Search operations, partners, products, documents
  - Get details with line items
  - Stock levels, net balances
  - Dashboard summary
  - German system prompt
  - localStorage history persistence
- **Issues encountered**:
  - LLM router broken → fixed with direct DeepSeek API call
  - DeepSeek API balance empty (HTTP 402) → needs alternative provider
- **Status**: ⚠️ 90% done, LLM provider needs fix

### 4. PIN Keypad Mobile Fix
- **Issue**: PIN digits 1-9 displayed vertically on mobile instead of 3x3 grid
- **Root cause**: globals.css rule `[style*="grid-template-columns"]:not(.dx-keep-grid)` collapsed all inline grids
- **Fix**: Added `className="dx-keep-grid"` to keypad container
- **Status**: ✅ Done

### 5. ERP Mobile Responsiveness (v2)
- **Added 32 new CSS rules** to globals.css:
  - Metric cards: 2-col on mobile
  - Status chips: prevent wrapping
  - Tables: sticky first column
  - Forms: prevent iOS zoom
  - Touch-friendly: 44px min tap targets
  - Das-Kompanion: full-width on mobile
  - Modals: full-screen on mobile
  - Pagination: larger buttons
- **Status**: ✅ Done

### 6. dasexperten.de Mobile Responsiveness (v2)
- **Added 18 new CSS rules** to styles.css:
  - Hero: better mobile layout, stacked CTAs
  - Product grid: horizontal cards on mobile
  - Science/feature grids: stack on mobile
  - Navigation: mobile drawer with larger tap targets
  - Footer: stacked on mobile
  - Quote/convert: better mobile spacing
  - Touch-friendly: 44px min tap targets
  - Smooth scroll, no horizontal overflow
- **Status**: ✅ Done

## Commits Made

### dasoperator repo
1. `777ae4b` — feat: add Das-Kompanion AI chatbot
2. `db062b3` — fix: Das-Kompanion v3 — robust LLM, history persistence
3. `05766fa` — fix: PIN keypad stays 3x3 grid on mobile (dx-keep-grid)
4. `3c59505` — feat: ERP mobile enhancements v2

### das-architektura repo
1. `96662fd` — feat: dasexperten.de mobile enhancements v2

## Pending Issues

### Critical
- [ ] **Das-Kompanion LLM provider**: DeepSeek API balance empty. Need to:
  - Option A: Top up DeepSeek balance
  - Option B: Switch to MiMo API (free tier available)
  - Option C: Use Anthropic via OAuth (already configured)
  - **Recommendation**: Use MiMo API for chatbot (free, fast)

### Medium
- [ ] **Ozon marketing**: Implement one of the presented ideas (bundles recommended)
- [ ] **dasexperten.de deploy**: CSS changes in CoWork repo, need to deploy to Cloudflare Pages

### Low
- [ ] **MiMo fallback script**: Currently only monitors, doesn't auto-switch back when free quota resets
- [ ] **Das-Kompanion features**: Add create operation flow with confirmation
- [ ] **Das-Kompanion features**: Add export functionality

## Files Modified

### ERP (dasoperator)
- `api/src/routes/chat.ts` — New chat API endpoint
- `web/components/das-kompanion/das-kompanion.tsx` — New chat widget
- `web/components/das-kompanion/das-kompanion-wrapper.tsx` — New layout wrapper
- `web/app/layout.tsx` — Added DasKompanionWrapper
- `web/components/home/home-dashboard.tsx` — Removed DasKompanion (moved to layout)
- `web/app/globals.css` — Added 32 mobile CSS rules
- `web/app/login/page.tsx` — Added dx-keep-grid class

### dasexperten.de (CoWork)
- `PROJECTS/dasexperten-de-website/public/styles.css` — Added 18 mobile CSS rules

### CoWork (local)
- `mimo-fallback.sh` — MiMo auto-switch script
- `~/Library/LaunchAgents/com.dasexperten.mimo-fallback.plist` — Launchd agent
- `~/Library/LaunchAgents/com.dasexperten.mimo-history-snapshot.plist` — DB backup agent
- `mimo-history/mimocode-history.db` — MiMo DB snapshot

## Key Learnings

1. **MiMo Code**: mimo-auto is free but has quota limits. No auto-switch built-in.
2. **Ozon Performance API**: Campaign data shows clear winners/bleeders. Budget reallocation is low-hanging fruit.
3. **Das-Kompanion**: Direct LLM API call is more reliable than router abstraction.
4. **Mobile CSS**: `[style*="grid-template-columns"]` selector is aggressive — always use `dx-keep-grid` for intentional inline grids.
5. **DeepSeek API**: Balance management is critical for production LLM usage.

## Next Session Priorities

1. Fix Das-Kompanion LLM provider (MiMo or Anthropic)
2. Deploy dasexperten.de CSS changes
3. Implement one Ozon marketing idea (bundles)
4. Test mobile responsiveness on real devices

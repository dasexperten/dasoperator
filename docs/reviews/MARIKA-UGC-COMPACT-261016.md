# Marika: compact UGC layout

The Owner requested a compact UGC page, removal of Import XLSX, and removal of the Link health panel. Published at https://erp.dasexperten.com/ugc on 16 October 2026.

Implementation: `8ab666e582565cd5d82a7fe7cac3bc29977dfcc4`. [Production Pages build passed](https://github.com/dasexperten/dasoperator/actions/runs/38899260477).

The UGC page now uses a smaller heading, reduced local padding, compact KPI cards and tighter spacing between controls. The import button and its unused frontend handler are removed. The Link health summary and its check button are removed. This change does not mutate creator records or alter backend link checks.

## Rendered verification

Before/after inspected at 1440 px and 390 px. The published desktop DOM measured:

| Element | Before | Published |
| --- | ---: | ---: |
| Heading height | 162.48 px | 56 px |
| KPI card height | 109.80 px | 81 px |
| Table top | 994.97 px | 433.70 px |

The table begins 561.27 px higher. Import XLSX button count and Link health panel count are both zero. No horizontal page overflow at either width. At 390 px, Filters expands and collapses correctly; visible select controls retain a 44 px height. Browser viewport restored after verification.

Validation passed: TypeScript check, diff whitespace check, tracking lint, Impeccable detector (no findings), production Pages build, and live desktop/mobile inspection. Shared global header and table layout remain outside this change.

Task: `INC-MARIKA-UGC-COMPACT-261016`, run `10150`.

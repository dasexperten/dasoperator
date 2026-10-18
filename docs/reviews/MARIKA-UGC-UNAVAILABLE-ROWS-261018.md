# UGC unavailable Instagram rows

Marika Nowicka accepted the scoped row change on 18 October 2026 before publication.

- Only a displayed primary Instagram profile with `availability_status === 'unavailable'` receives the faded class. Null, available, non-Instagram and old metrics do not imply unavailability.
- Desktop table row and mobile row use opacity 0.72 and grayscale. Hover or keyboard focus within restores full opacity and color. No pointer events are disabled; existing profile, avatar, payment and card handlers remain intact.
- A visible `Instagram недоступен` label explains the treatment. Its tooltip includes the checked time in Yerevan and the stored evidence note when present.
- Existing lifecycle, archival and payment state are untouched by the UI change.

## Evidence

Native Chrome viewport captures of a clearly labelled local fixture using the current production stylesheet and matching row structure, with synthetic creator data:

- `.tmp/ugc-row-review/before-1440.jpg`, `after-1440.jpg` at 1440 × 900.
- `.tmp/ugc-row-review/before-390.jpg`, `after-390.jpg` at 390 × 844.

This is fixture acceptance, not a production-data claim. Parent task verifies the deployed page after publication.

At 390 px the document has no horizontal overflow; both creator rows measure 53 px. The availability label is visible below the unavailable handle; figures and payment controls remain aligned. DOM inspection confirms the normal row opacity is 1 and the unavailable row is 0.72; keyboard focus within restores opacity 1 and filter none. Fixture buttons remain enabled with pointer-events auto. Temporary browser viewport was reset.

Changed classes: `ugc-creator-row-unavailable`, `ugc-profile-unavailable`, `ugc-mobile-profile-copy`. Existing row classes retained. No font or palette token added. Brighter review preserves the current branded working palette; the neutral unavailable treatment is deliberate Owner-requested state information. Main handle, figures and explanatory label remain clear; fully colored controls return on interaction.

Frontend `tsc --noEmit -p web/tsconfig.json` passed. Impeccable detector found only two existing accent-border warnings outside the changed rules (page header and payment badge); no new detector finding was introduced.

Commit trailer:

`Look-accepted: Marika Nowicka · UGC unavailable rows; fixture before/after 390 and 1440 px; zero mobile overflow; focus restores full visibility`

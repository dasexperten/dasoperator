# UGC: 50 additional profiles and list avatars

Owner requested 50 more Instagram profiles, with results visible inside the production ERP, and a circular avatar before each account name in the main list.

## Measured production result

The baseline contained 21 previously attempted profiles. Exactly **50 distinct additional profiles** were attempted; all 50 had a null attempt date in that baseline. Production D1 was read back and compared field by field with the final manifest.

- 46 profiles supplied at least one usable field. This does not mean every metric was available for each profile.
- 45 real avatars stored in the private bucket.
- Publication counts available for 25 profiles.
- Fresh ER observations for 19 profiles, with sample size and observation date retained.
- Four unavailable profiles: `nadezdaorlova_no`, `efriz96`, `su.nnat891`, `mariya_ibramkhalilova`. Prior follower values were verified unchanged; unknowns were not replaced by zero.
- Example: [@faina_make in ERP](https://erp.dasexperten.com/ugc?search=faina_make) shows 8075 followers, 409 publications and 1.78% ER from six posts, observed 17 October at 13:37 Asia/Yerevan. Its private avatar loaded successfully in both row and modal.

## List interaction

Circular 32 px avatars precede account names in desktop and phone lists. The modal retains a 72 px avatar. Missing photos use the existing neutral Users icon. Images load when rows approach the viewport, through the existing authenticated endpoint; desktop, phone and modal share an in-memory request cache. No public bucket or token-bearing image URL was introduced.

Live desktop verification: 32 x 32, 50% radius, real image decoded, avatar right edge before account name, no overlap. Mobile verification uses 390 x 844 and checks alignment and page overflow. Row whitespace still opens the native blogger modal. Account and status links retain their distinct destinations. This test sent no Direct messages and executed no payments.

## Execution recovery

The first long manual worker HTTP request was cancelled after the client's 300-second headers timeout. Cloudflare invocation analytics confirmed `clientDisconnected` and D1 had persisted 19 profiles. Only that invocation's exact lease was released after cancellation was confirmed; its cron run (69195) retains the failure and partial count. The remaining profiles were processed through short authenticated production refresh calls (two per call, one for the last remaining account). The baseline comparison prevented recounting the prior 21 profiles or overshooting 50.

## Code and validation

- Avatar list implementation: `f2f49136bb7327c41650f12c9a37bb8ef31a8c40`; Pages deploy 39021822466 and Checks 39021822484 succeeded.
- Mobile alignment: `f88ee47f97dd07637e6c69e4319371ff2656ed61`; Pages deploy 39022060673 succeeded; Checks 39022060473 succeeded.
- Frontend TypeScript and git diff whitespace checks passed.
- Local evidence: `/private/tmp/marika-ugc-row-avatar-desktop-261017.png`, `/private/tmp/marika-ugc-row-avatar-mobile-261017.png`, `/private/tmp/marika-ugc-50-faina-card-261017.png`.

## Additional profiles

| Account | Avatar | Followers retained or observed | Publications | Fresh ER sample |
| --- | --- | ---: | ---: | ---: |
| @_gadzhimetova_ | yes | 8478 | 80 | 6 |
| @_li_family | yes | 444 | 176 | 6 |
| @_saniyat93 | unavailable | 22000 | 182 | 6 |
| @ainushkaaa_m | yes | 2727 | 208 | 6 |
| @aishat_nail_ | yes | 1560 | unknown | unavailable |
| @am__111___ | yes | 1691 | 47 | 6 |
| @amina_k_26 | yes | 4150 | unknown | unavailable |
| @asmirai_09_ | yes | 4571 | 255 | 6 |
| @atika_ti_ | yes | unknown | unknown | unavailable |
| @blog_lezginka_22 | yes | 1189 | 622 | 6 |
| @blogger_alba | yes | 4254 | 601 | 6 |
| @blondinochka_777_ | yes | 24084 | unknown | unavailable |
| @dina_lifestylee | yes | unknown | unknown | unavailable |
| @dinara_magomedova.2.4 | yes | 3243 | 112 | 6 |
| @djamka_blog | yes | 13838 | 896 | unavailable |
| @efriz96 | unavailable | unknown | unknown | unavailable |
| @eseniya__oo3__ | yes | 1557 | unknown | unavailable |
| @faina_make | yes | 8075 | 409 | 6 |
| @fatima_massage26 | yes | 5827 | unknown | unavailable |
| @gr.y.ser | yes | 772 | 163 | 6 |
| @inna35707 | yes | 3055 | unknown | unavailable |
| @irina__sayapina | yes | 5421 | unknown | unavailable |
| @kazieva_zk | yes | 7330 | unknown | unavailable |
| @khumairo274 | yes | 3288 | unknown | unavailable |
| @kodirov_96_oooo | yes | 7782 | 543 | 6 |
| @korol1na_20 | yes | 3371 | unknown | unavailable |
| @larrrsi | yes | 2826 | unknown | unavailable |
| @liana_xachatryan_abidzhba | yes | 2288 | 382 | unavailable |
| @m_aadishka_ | yes | unknown | unknown | unavailable |
| @maksmir93 | yes | 1652 | unknown | unavailable |
| @mamavlada19.07 | yes | 1051 | unknown | unavailable |
| @marishka_17_19 | yes | 14000 | 241 | 6 |
| @mariya_ibramkhalilova | unavailable | unknown | unknown | unavailable |
| @maryam_12s11 | yes | 6703 | unknown | unavailable |
| @mimoprohodite555 | yes | 1394 | unknown | unavailable |
| @mis_alina_010 | yes | 3165 | 115 | 6 |
| @ms.polina1991p | yes | 7958 | unknown | unavailable |
| @my_cosy__blog | yes | 1498 | 119 | 6 |
| @nadezdaorlova_no | unavailable | unknown | unknown | unavailable |
| @natalia_mir77 | yes | 1 | 10 | 6 |
| @natalia_mit78 | yes | 249 | 64 | unavailable |
| @nazarovas2004 | yes | 1297 | 55 | 6 |
| @rukiyat_zhebel | yes | 2428 | 175 | 6 |
| @seva_cellflex | yes | 9208 | 370 | unavailable |
| @su.nnat891 | unavailable | 3356 | unknown | unavailable |
| @uma_sh._ | yes | 2262 | unknown | unavailable |
| @vedmochka_z | yes | 4070 | 197 | unavailable |
| @verezomskaiakristina | yes | 896 | 199 | unavailable |
| @yasmin_i.b | yes | 4913 | unknown | unavailable |
| @zarina18_97 | yes | 7773 | 45 | 6 |

Owner follow-up: whitespace inside the full-width account anchor also opens the modal. Actual text and icons keep their own actions; blank anchor navigation is cancelled in both desktop and mobile row handlers.

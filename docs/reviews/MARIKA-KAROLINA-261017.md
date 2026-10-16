# Marika: restore Karolina's second basket to the payment queue

Owner request: `karolina` is waiting; why is the payment not showing? Matched the existing creator `@korol1na_20` (display name Korolina).

The existing 758 RUB payout was executed in Konsol on 16 October. Later messages explicitly concern a second basket. After a basket revision the creator supplied 900 RUB and new recipient details. The automatic reply at the latest incoming message was recorded as escalated with reason `unparsable`, and the same incoming timestamp was marked handled. No new payout row was created, so the UGC page showed only the earlier paid amount.

Restored one awaiting payout for 900 RUB, dated 17 October in Yerevan time, from the new conversation details. The recovery id derives from the unique incoming amount-message id, and an existing-open-row check prevents an additional copy. Recipient phone and name remain only in the ERP requisites table; they are not recorded here. Product is left unknown pending interpretation of the new basket image.

Verified in the live UGC page filtered to `korol1na_20`: 900 RUB is an enabled brown payment button. Requisites exist; the new payout has no Konsol payment id. The earlier 758 RUB payout remains executed. No payment or outbound message to the creator was sent in this session.

New payout: `ugc_recovered_683912d14b884d7bf7f0c3e8`. Task `INC-MARIKA-KAROLINA-261017`, run `10156`. The malformed-response handling in the automatic responder remains a separate code follow-up; this recovery does not change that code.

-- 0107: Yangzhou Jinxia signatory name is Lois Guan, not "Luis Guan" (0064 misspelling).
-- Evidence: the authorised hand-signature scan reads "Lois Guan"
-- (tools/invoice-templates/assets/lois_guan_signature.png), the locked RF
-- invoice-specification template names "Lois Guan", and the contacts registry
-- lists Lois Guan for Jinxia. Owner 06.10.2026 ordered the IS data fixed and
-- reissued. Title is left as it is: 0064 says General Manager, the template and
-- contacts say Sales Manager — that conflict goes to the Owner, not to a guess.
UPDATE manufacturers
SET signing_authority_name = 'Lois Guan'
WHERE signing_authority_name = 'Luis Guan';

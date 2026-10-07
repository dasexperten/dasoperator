-- 0108: Yangzhou Jinxia signatory Lois Guan is Sales Manager.
-- Owner 07.10.2026 settled the title conflict left open in 0107: 0064 said
-- General Manager; the template and contacts said Sales Manager — Sales Manager stands.
UPDATE manufacturers
SET signing_authority_title_en = 'Sales Manager',
    signing_authority_title_ru = 'Менеджер по продажам'
WHERE id = 'jinxia' AND signing_authority_name = 'Lois Guan';

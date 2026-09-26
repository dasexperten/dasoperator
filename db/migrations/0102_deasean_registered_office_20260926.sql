-- DAS EXPERTEN ASEAN (0319132917): registered office changed by ERC 5th amendment, 26/09/2026 (Owner 2026-09-26, approved "go ahead with the ERP change").
-- Toà nhà Mộc Gia, Tầng 6, 238-240-242 Nguyễn Oanh, Phường Gò Vấp, TP. Hồ Chí Minh. Company tel 0931 679 853.
-- Supersedes 153 Dai Lo Doc Lap, Phuong Di An (set 16.09.2026, never registered) and 140 Nguyen Van Khoi.
UPDATE companies
   SET registered_address = 'Moc Gia Building, 6th Floor, 238-240-242 Nguyen Oanh, Go Vap Ward, Ho Chi Minh City, Vietnam. Tel 0931 679 853',
       notes = COALESCE(notes,'') || ' · Registered office changed 26.09.2026 (ERC 5th amendment): Toà nhà Mộc Gia, Tầng 6, 238-240-242 Nguyễn Oanh, Phường Gò Vấp, TP.HCM (was 153 Dai Lo Doc Lap, Phuong Di An).',
       updated_at = unixepoch()
 WHERE id = 'dasean';

import ContractDetailClient from './contract-detail-client';

// Static export requires generateStaticParams. IDs match actual SQL backfill
// from migration 0005 — derived as 'ctr_' + lower-snake-case of contract_no.
// New contracts created via UI form won't have detail pages until next deploy
// (Static Export limitation; UI form redirects to /contracts list page).
export function generateStaticParams() {
  return [
    { id: 'ctr_dee_ap_2024_04' },   // ArvitPharm
    { id: 'ctr_dee_nt_2024_05' },   // Natusana (note: contract_no starts DEE but entity = DEI)
    { id: 'ctr_dee_tm_2024_02' },   // TAMA
    { id: 'ctr_dee_tw_2024_01' },   // Torwey
    { id: 'ctr_dei_tg_2024_01' },   // TORI Georgia
    { id: 'ctr_dei_vs_2024_03' },   // VIP SALES
  ];
}

export const dynamicParams = false;

export default function ContractDetailPage({ params }: { params: { id: string } }) {
  return <ContractDetailClient contractId={params.id} />;
}

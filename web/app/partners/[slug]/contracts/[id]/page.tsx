import ContractDetailClient from './contract-detail-client';

// Static export requires generateStaticParams. 6 known partner+contract pairs
// from migration 0005 backfill (verified against live API at deploy time).
export function generateStaticParams() {
  return [
    { slug: 'prt_torwey',       id: 'ctr_dee_tw_2024_01' },  // Torwey
    { slug: 'prt_tama',         id: 'ctr_dee_tm_2024_02' },  // TAMA
    { slug: 'prt_tori_georgia', id: 'ctr_dei_tg_2024_01' },  // TORI Georgia
    { slug: 'prt_arvitpharm',   id: 'ctr_dee_ap_2024_04' },  // ArvitPharm
    { slug: 'prt_natusana',     id: 'ctr_dee_nt_2024_05' },  // Natusana
    { slug: 'prt_vip_sales',    id: 'ctr_dei_vs_2024_03' },  // VIP SALES
  ];
}

export const dynamicParams = false;

export default function ContractDetailPage({ params }: { params: { slug: string; id: string } }) {
  return <ContractDetailClient partnerSlug={params.slug} contractId={params.id} />;
}

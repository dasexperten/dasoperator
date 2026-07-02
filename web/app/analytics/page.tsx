import AnalyticsDashboard from './AnalyticsDashboard';

export const runtime = 'edge';

export const metadata = {
  title: 'Аналитика рекламы — Das Operator',
  description: 'Реклама Ozon + Wildberries: расход, ДРР, рекомендации',
};

export default function AnalyticsPage() {
  return <AnalyticsDashboard />;
}

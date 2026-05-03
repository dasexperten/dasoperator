import BindingStatus from '@/components/home/binding-status';
import CountsGrid from '@/components/home/counts-grid';

export default function HomePage() {
  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Home</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Live infrastructure metrics and reference data overview
        </p>
      </div>

      <BindingStatus />
      <CountsGrid />
    </div>
  );
}

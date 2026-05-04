import BindingStatus from '@/components/home/binding-status';
import CountsGrid from '@/components/home/counts-grid';

export default function HomePage() {
  return (
    <div className="space-y-10 max-w-6xl">
      <div>
        <div className="dx-eyebrow dx-eyebrow-rot mb-2">Pulse</div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
            color: 'var(--fg-1)',
          }}
        >
          Das Operator
        </h1>
        <p
          className="mt-3"
          style={{
            fontSize: 'var(--fs-body-lg)',
            color: 'var(--fg-2)',
            maxWidth: '560px',
          }}
        >
          Live infrastructure metrics and reference data overview.
          Internal ERP for Das Experten group entities.
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <BindingStatus />
      <CountsGrid />
    </div>
  );
}

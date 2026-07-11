import type { ReactNode } from 'react';

interface PageHeaderProps {
  /** Small red eyebrow label above the title, e.g. "Communications" */
  eyebrow: string;
  /** Page title, rendered in the display font */
  title: string;
  /**
   * Deprecated / no longer rendered. House rule: pages do not show a subtitle
   * line. The prop is kept so existing callers still compile, but it is ignored.
   */
  subtitle?: ReactNode;
  /** Optional action cluster (buttons / links) shown to the right of the title */
  actions?: ReactNode;
}

/**
 * Das Experten brand page header.
 *
 * Encodes the house header pattern used across the ERP (Warehouses, Products, …):
 * red eyebrow → display title → three-ribbon rule. Action clusters sit to the
 * right on desktop and wrap below the title on mobile.
 *
 * House rule: no subtitle line. The `subtitle` prop is accepted (for backward
 * compatibility) but intentionally NOT rendered — pages stay clean, titles only.
 */
export default function PageHeader({ eyebrow, title, actions }: PageHeaderProps) {
  return (
    <div className="space-y-8 max-w-full">
      <div className="flex items-start justify-between gap-4 dx-header-wrap">
        <div>
          <div className="dx-eyebrow-rot mb-2">{eyebrow}</div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--fs-display-md)',
              fontWeight: 900,
              color: 'var(--fg-1)',
            }}
          >
            {title}
          </h1>
        </div>
        {actions != null && (
          <div className="shrink-0 flex items-center gap-2 dx-page-actions">{actions}</div>
        )}
      </div>

      <div className="dx-ribbon-rule" />
    </div>
  );
}

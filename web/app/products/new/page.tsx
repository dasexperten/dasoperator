import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function NewProductPlaceholder() {
  return (
    <div className="space-y-6 max-w-2xl">
      <Link
        href="/products"
        className="inline-flex items-center gap-1"
        style={{ fontSize: '14px', color: 'var(--fg-2)' }}
      >
        <ArrowLeft className="h-4 w-4" />Back to Products
      </Link>

      <div className="dx-eyebrow-rot mb-2">Coming Soon</div>
      <h1 style={{
        fontFamily: 'var(--font-display)',
        fontSize: 'var(--fs-display-md)',
        fontWeight: 900,
        
        color: 'var(--fg-1)',
      }}>
        Add Product
      </h1>
      <p style={{ fontSize: 'var(--fs-body-lg)', color: 'var(--fg-2)' }}>
        Coming in Phase 5.4 — full product create form including manufacturer
        selection, packaging carton dimensions, country of origin, descriptions
        in 3 languages, and image upload.
      </p>

      <div className="p-5" style={{
        backgroundColor: 'var(--paper-sunk)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}>
        <div className="mb-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
          For now — manual SQL or API
        </div>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)', lineHeight: 1.5 }}>
          Until Phase 5.4 lands, new SKUs can be added directly via D1 or by
          POSTing to <code>/api/products</code> (also coming in 5.4).
        </p>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { getHealth, type HealthResponse } from '@/lib/api';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

const BINDINGS = ['DB', 'DOCS', 'COUNTERS', 'FX', 'CACHE'] as const;

export default function BindingStatus() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await getHealth();
        if (res.success && res.result) {
          setData(res.result);
          setError(null);
        } else {
          setError(res.errors[0]?.message ?? 'Unknown error');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="dx-eyebrow mb-4">Infrastructure Status</div>
      <div className="grid grid-cols-5 gap-4">
        {BINDINGS.map((name) => {
          const binding = data?.bindings[name];

          return (
            <div
              key={name}
              className="bg-card p-5 transition-colors"
              style={{
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div
                className="dx-eyebrow mb-3"
                style={{ fontSize: '10px', color: 'var(--fg-3)' }}
              >
                {name}
              </div>
              {loading || !binding ? (
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-muted)' }} />
              ) : binding.status === 'ok' ? (
                <div>
                  <CheckCircle2 className="h-5 w-5 mb-2" style={{ color: 'var(--status-success)' }} />
                  <div className="dx-mono" style={{ fontSize: '13px', color: 'var(--fg-2)' }}>
                    {binding.latency_ms}<span style={{ color: 'var(--fg-3)' }}>ms</span>
                  </div>
                </div>
              ) : (
                <div>
                  <XCircle className="h-5 w-5 mb-2" style={{ color: 'var(--brand-rot)' }} />
                  <div className="dx-mono" style={{ fontSize: '12px', color: 'var(--brand-rot)' }}>
                    error
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <p className="mt-3 text-xs" style={{ color: 'var(--brand-rot)' }}>
          Error: {error}
        </p>
      )}
    </div>
  );
}

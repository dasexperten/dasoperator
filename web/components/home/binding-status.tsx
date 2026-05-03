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
      <h3 className="text-sm font-medium text-muted-foreground mb-3">Infrastructure Status</h3>
      <div className="grid grid-cols-5 gap-3">
        {BINDINGS.map((name) => {
          const binding = data?.bindings[name];

          return (
            <div
              key={name}
              className="bg-card border border-border rounded-lg p-4 flex flex-col items-center"
            >
              <div className="text-xs text-muted-foreground mb-2">{name}</div>
              {loading || !binding ? (
                <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
              ) : binding.status === 'ok' ? (
                <>
                  <CheckCircle2 className="h-6 w-6 text-green-500 mb-1" />
                  <div className="text-xs font-mono text-muted-foreground">
                    {binding.latency_ms}ms
                  </div>
                </>
              ) : (
                <>
                  <XCircle className="h-6 w-6 text-red-500 mb-1" />
                  <div className="text-xs text-red-400">error</div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-400">Error fetching health: {error}</p>
      )}
    </div>
  );
}

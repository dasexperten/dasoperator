'use client';

import { useEffect, useState } from 'react';
import { getProducts } from '@/lib/api';

interface Counts {
  companies: number;
  partners: number;
  products: number;
  warehouses: number;
}

const REFERENCE_COUNTS: Counts = {
  companies: 4,
  partners: 6,
  products: 20,
  warehouses: 9,
};

export default function CountsGrid() {
  const [counts, setCounts] = useState<Counts>(REFERENCE_COUNTS);
  const [productsLive, setProductsLive] = useState<number | null>(null);

  useEffect(() => {
    const fetchProducts = async () => {
      try {
        const res = await getProducts('DE');
        if (res.success && res.result) {
          setProductsLive(res.result.count);
          setCounts({ ...REFERENCE_COUNTS, products: res.result.count });
        }
      } catch {
        // Keep static counts
      }
    };
    fetchProducts();
  }, []);

  const cards = [
    { label: 'Entities', value: counts.companies, live: false },
    { label: 'Partners', value: counts.partners, live: false },
    { label: 'Products', value: counts.products, live: productsLive !== null },
    { label: 'Warehouses', value: counts.warehouses, live: false },
  ];

  return (
    <div>
      <div className="dx-eyebrow mb-4">Reference Data</div>
      <div className="grid grid-cols-4 gap-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-card p-5"
            style={{
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div
              className="dx-numeral"
              style={{
                fontSize: '40px',
                color: 'var(--fg-1)',
                lineHeight: 1,
              }}
            >
              {card.value}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div
                className="dx-eyebrow"
                style={{ fontSize: '10px', color: 'var(--fg-3)' }}
              >
                {card.label}
              </div>
              {card.live && (
                <div
                  className="rounded-full"
                  style={{
                    width: '6px',
                    height: '6px',
                    backgroundColor: 'var(--status-success)',
                  }}
                  title="Live data"
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

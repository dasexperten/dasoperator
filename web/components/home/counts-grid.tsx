'use client';

import { useEffect, useState } from 'react';
import { getProducts } from '@/lib/api';

interface Counts {
  companies: number;
  partners: number;
  products: number;
  warehouses: number;
}

// Static counts from Phase 1.2 reference seed (we know these are correct)
// Future: replace with /api/counts endpoint
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
    { label: 'Companies', value: counts.companies, live: false },
    { label: 'Partners', value: counts.partners, live: false },
    { label: 'Products', value: counts.products, live: productsLive !== null },
    { label: 'Warehouses', value: counts.warehouses, live: false },
  ];

  return (
    <div>
      <h3 className="text-sm font-medium text-muted-foreground mb-3">Reference Data</h3>
      <div className="grid grid-cols-4 gap-3">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-card border border-border rounded-lg p-4"
          >
            <div className="text-3xl font-semibold text-foreground">{card.value}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {card.label}
              {card.live && <span className="ml-1 text-green-500">●</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

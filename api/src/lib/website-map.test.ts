import { describe, it, expect } from 'vitest';
import {
  normalizeSku,
  mapOrder,
  mapOrderLines,
  mapPrice,
  type StripeCheckoutSession,
  type StripePrice,
  type StripeProduct,
} from './website-map';

describe('normalizeSku', () => {
  it('trims and lowercases', () => {
    expect(normalizeSku('  DE201 ')).toBe('de201');
  });
  it('returns null for empty/nullish', () => {
    expect(normalizeSku('')).toBeNull();
    expect(normalizeSku('   ')).toBeNull();
    expect(normalizeSku(null)).toBeNull();
    expect(normalizeSku(undefined)).toBeNull();
  });
});

const known = new Set(['de201', 'de210']);

// A realistic completed Checkout Session with two line items:
// one whose SKU is in the ERP catalog, one that is not.
const session: StripeCheckoutSession = {
  id: 'cs_test_abc',
  created: 1751000000,
  status: 'complete',
  payment_status: 'paid',
  currency: 'usd',
  amount_subtotal: 3540,
  amount_total: 4030,
  total_details: { amount_discount: 0, amount_shipping: 490, amount_tax: 0 },
  customer_details: { email: 'buyer@example.com', name: 'Jane Buyer', address: { country: 'DE' } },
  shipping_details: { address: { country: 'AT' } },
  payment_intent: 'pi_test_123',
  line_items: {
    data: [
      {
        description: 'INNOWEISS',
        quantity: 1,
        amount_total: 2550,
        price: { id: 'price_1', unit_amount: 2550, currency: 'usd', product: 'prod_1', metadata: { sku: 'DE210' } },
      },
      {
        description: 'Mystery brush',
        quantity: 2,
        amount_total: 990,
        price: { id: 'price_2', unit_amount: 495, currency: 'usd', product: 'prod_2', metadata: { sku: 'BRUSH-X' } },
      },
    ],
  },
};

describe('mapOrder', () => {
  it('maps money in cents and uppercases currency', () => {
    const row = mapOrder(session);
    expect(row.id).toBe('cs_test_abc');
    expect(row.currency).toBe('USD');
    expect(row.amount_total).toBe(4030);
    expect(row.amount_shipping).toBe(490);
    expect(row.payment_status).toBe('paid');
    expect(row.payment_intent).toBe('pi_test_123');
    expect(row.number).toBe('pi_test_123');
  });
  it('prefers shipping_details country over billing', () => {
    expect(mapOrder(session).ship_country).toBe('AT');
  });
  it('handles a bare session with no details without throwing', () => {
    const row = mapOrder({ id: 'cs_bare', created: 1 });
    expect(row.amount_total).toBe(0);
    expect(row.currency).toBe('USD');
    expect(row.buyer_email).toBeNull();
    expect(row.ship_country).toBeNull();
  });
});

describe('mapOrderLines', () => {
  it('matches known SKU and leaves unknown as null (no throw)', () => {
    const [first, second] = mapOrderLines(session, known);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.product_id).toBe('de210');
    expect(first!.sku_raw).toBe('de210');
    expect(first!.id).toBe('cs_test_abc_0');
    expect(second!.product_id).toBeNull();
    expect(second!.sku_raw).toBe('brush-x');
    expect(second!.qty).toBe(2);
    // unit derived from line_total / qty when unit_amount present -> uses unit_amount
    expect(second!.unit_amount).toBe(495);
  });
  it('derives unit from line total when unit_amount missing', () => {
    const s: StripeCheckoutSession = {
      id: 'cs_x',
      created: 1,
      line_items: { data: [{ quantity: 3, amount_total: 900, price: { id: 'p', unit_amount: null, currency: 'usd', metadata: { sku: 'de201' } } }] },
    };
    expect(mapOrderLines(s, known)[0]!.unit_amount).toBe(300);
  });
  it('returns [] for a session with no line items', () => {
    expect(mapOrderLines({ id: 'cs_e', created: 1 }, known)).toEqual([]);
  });
});

describe('mapPrice', () => {
  const products = new Map<string, StripeProduct>([
    ['prod_1', { id: 'prod_1', name: 'INNOWEISS whitening', metadata: { sku: 'DE210' } }],
  ]);
  it('matches SKU via price metadata and pulls product name', () => {
    const price: StripePrice = { id: 'price_1', unit_amount: 2550, currency: 'usd', active: true, product: 'prod_1', metadata: { sku: 'DE210' } };
    const row = mapPrice(price, products, known);
    expect(row.product_id).toBe('de210');
    expect(row.name).toBe('INNOWEISS whitening');
    expect(row.unit_amount).toBe(2550);
    expect(row.active).toBe(1);
  });
  it('falls back to product metadata for SKU', () => {
    const price: StripePrice = { id: 'price_9', unit_amount: 990, currency: 'usd', product: 'prod_1' };
    expect(mapPrice(price, products, known).product_id).toBe('de210');
  });
  it('marks inactive prices and unknown SKU without throwing', () => {
    const price: StripePrice = { id: 'price_z', unit_amount: 100, currency: 'usd', active: false, product: 'prod_unknown', metadata: { sku: 'ZZZ' } };
    const row = mapPrice(price, products, known);
    expect(row.active).toBe(0);
    expect(row.product_id).toBeNull();
    expect(row.sku_raw).toBe('zzz');
  });
});

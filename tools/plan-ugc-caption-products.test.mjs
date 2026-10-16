import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyCaptionProducts, planCaptionProducts } from './plan-ugc-caption-products.mjs';
const map = [{ nm_id: 271980094, base_sku: 'de210' }, { nm_id: 313250836, base_sku: 'de310' }];
const item = { id: 'c', creator_id: 'a', creator_platform_id: 'ig', normalized_handle: 'author', content_url: 'https://www.instagram.com/reel/ABC/?hl=ru', product_status: 'queued' };
test('marketplace article disambiguates toothpaste from mouthwash, never by the number alone', () => {
  assert.deepEqual(identifyCaptionProducts('Артикул #271980094', map).codes, ['DE210']);
  assert.deepEqual(identifyCaptionProducts('Артикул 313250836', map).codes, ['DE310']);
  assert.deepEqual(identifyCaptionProducts('Артикул 3497962138', map).codes, []);
  assert.deepEqual(identifyCaptionProducts('Артикул 271980094', [...map, { nm_id: 271980094, base_sku: 'de310' }]).codes, []);
});
test('joins reel and post by exact shortcode and verified owner', () => {
  const post = { url: 'https://www.instagram.com/p/ABC/', ownerUsername: 'author', caption: 'Артикул 271980094' };
  assert.equal(planCaptionProducts([post], [item], map).summary.identified, 1);
  assert.equal(planCaptionProducts([{ ...post, ownerUsername: 'someone_else' }], [item], map).updates.length, 0);
  assert.equal(planCaptionProducts([{ ...post, url: 'https://www.instagram.com/p/OTHER/' }], [item], map).updates.length, 0);
});
test('an inaccessible post never erases a completed product or manual decision', () => {
  const post = { url: item.content_url, error: 'not_found' };
  assert.equal(planCaptionProducts([post], [{ ...item, product_status: 'identified', product_codes: '["DE210"]' }], map).updates.length, 0);
  assert.equal(planCaptionProducts([post], [{ ...item, product_source: 'manual' }], map).updates.length, 0);
});

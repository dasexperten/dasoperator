import assert from 'node:assert/strict';
import test from 'node:test';
import { formatActivity, formatCount, formatRate, platformLabel } from './ugc-table-format.mjs';

const NBSP = ' ';

test('counts are whole, grouped with a non-breaking space', () => {
  assert.equal(formatCount(5964), `5${NBSP}964`);
  assert.equal(formatCount(1447.7), `1${NBSP}448`);
  assert.equal(formatCount(3_600_000), `3${NBSP}600${NBSP}000`);
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
});

test('engagement keeps one decimal and its percent sign', () => {
  assert.equal(formatRate(4.25), `4,3${NBSP}%`);
  assert.equal(formatRate(0), `0${NBSP}%`);
  assert.equal(formatRate(null), '—');
});

test('activity is the Yerevan day, year only when it differs', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(formatActivity(Date.parse('2026-10-12T21:30:00Z'), now), '13.10');
  assert.equal(formatActivity(Date.parse('2025-12-31T10:00:00Z'), now), '31.12.25');
  assert.equal(formatActivity(null, now), '—');
});

test('networks keep their own spelling', () => {
  assert.equal(platformLabel('tiktok'), 'TikTok');
  assert.equal(platformLabel('youtube'), 'YouTube');
  assert.equal(platformLabel('vk'), 'VK');
  assert.equal(platformLabel('other'), 'Другое');
  assert.equal(platformLabel(''), '—');
});

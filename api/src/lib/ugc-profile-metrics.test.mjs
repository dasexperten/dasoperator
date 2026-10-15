import assert from 'node:assert/strict';
import test from 'node:test';
import { profileAverages } from './ugc-profile-metrics.mjs';

const measured = { source: 'instagram_public;profile+reel;run', metrics_as_of: '2026-10-15T22:08:25Z', avg_video_views: 236.6, median_video_views: 204, avg_comments: 1.8 };

test('fresh creator sample is not replaced by older campaign averages', () => {
  assert.deepEqual(profileAverages(measured, { views: [1000, 1687], comments: [8, 15] }), {
    avg_video_views: 236.6, median_video_views: 204, avg_comments: 1.8,
  });
});

test('unknown measured values stay unknown even when campaign observations exist', () => {
  assert.deepEqual(profileAverages({ ...measured, avg_video_views: null, median_video_views: null, avg_comments: null }, { views: [543, 700], comments: [1, 2] }), {
    avg_video_views: null, median_video_views: null, avg_comments: null,
  });
});

test('measured zero remains a real zero', () => {
  assert.deepEqual(profileAverages({ ...measured, avg_video_views: 0, median_video_views: 0, avg_comments: 0 }, { views: [100, 200], comments: [5, 6] }), {
    avg_video_views: 0, median_video_views: 0, avg_comments: 0,
  });
});

test('legacy workbook rows retain campaign aggregation', () => {
  assert.deepEqual(profileAverages({ ...measured, source: 'Blooger Database.xlsx' }, { views: [100, 200, 300, 400], comments: [1, 3] }), {
    avg_video_views: 250, median_video_views: 250, avg_comments: 2,
  });
});

test('an undated public source does not imply a verified sample', () => {
  assert.deepEqual(profileAverages({ ...measured, metrics_as_of: null }, { views: [100, 200], comments: [1, 3] }), {
    avg_video_views: 150, median_video_views: 150, avg_comments: 2,
  });
});

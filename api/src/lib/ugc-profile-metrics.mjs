// A dated public-profile sample and the brand's campaign publications measure
// different populations. Preserve the measured profile sample, including unknowns.
export function profileAverages(profile, observed) {
  if (/^[a-z]+_public;/.test(profile.source ?? '')
      && typeof profile.metrics_as_of === 'string'
      && Number.isFinite(Date.parse(profile.metrics_as_of))) {
    return {
      avg_video_views: profile.avg_video_views ?? null,
      median_video_views: profile.median_video_views ?? null,
      avg_comments: profile.avg_comments ?? null,
    };
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...observed.views].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    avg_video_views: sorted.length >= 2 ? mean(sorted) : (profile.avg_video_views ?? null),
    median_video_views: sorted.length >= 2
      ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
      : (profile.median_video_views ?? null),
    avg_comments: observed.comments.length >= 2 ? mean(observed.comments) : (profile.avg_comments ?? null),
  };
}

type Averages = { avg_video_views: number | null; median_video_views: number | null; avg_comments: number | null };
export function profileAverages(
  profile: Partial<Averages> & { source?: string | null; metrics_as_of?: string | null },
  observed: { views: number[]; comments: number[] },
): Averages;

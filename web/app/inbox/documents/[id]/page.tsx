export const runtime = 'edge';

import ReviewClient from './review-client';

export default function ExtractionReviewPage({ params }: { params: { id: string } }) {
  return <ReviewClient id={params.id} />;
}

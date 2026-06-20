import React from 'react';

interface Review {
  id: string;
  author: string;
  date: string;
  platform: 'ozon' | 'wb' | 'email';
  rating: number;
  text: string;
  answer?: string;
  productSku?: string;
  productFamily?: string;
}

interface ReviewCardProps {
  review: Review;
}

export function ReviewCard({ review }: ReviewCardProps) {
  const stars = Array.from({ length: 5 }, (_, i) => i < review.rating);

  return (
    <article className="review-card" aria-label={`Review by ${review.author}`}>
      <div className="review-header">
        <div className="review-meta">
          <span className="review-author">{review.author}</span>
          <time className="review-date" dateTime={review.date}>
            {new Date(review.date).toLocaleDateString('ru-RU')}
          </time>
        </div>
        <span className={`platform-badge platform-badge--${review.platform}`}>
          {review.platform.toUpperCase()}
        </span>
      </div>

      <div className="star-rating" aria-label={`${review.rating} out of 5 stars`}>
        {stars.map((filled, i) => (
          <svg
            key={i}
            className={`star ${filled ? 'star--filled' : ''}`}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        ))}
      </div>

      <p className="review-text">{review.text}</p>

      {review.answer && (
        <div className="review-answer">
          <div className="review-answer-label">Наш ответ</div>
          <p className="review-answer-text">{review.answer}</p>
        </div>
      )}
    </article>
  );
}

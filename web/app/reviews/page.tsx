'use client';

import React, { useState, useEffect } from 'react';

type Review = {
  id: string;
  author: string;
  rating: number;
  comment: string;
  createdAt: string;
  platform?: string;
};

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    const fetchReviews = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/reviews');
        
        if (!response.ok) {
          throw new Error('Failed to fetch reviews');
        }
        
        const data = await response.json();
        setReviews(data.reviews || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchReviews();
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]" style={{ color: 'var(--fg-3)' }}>
        <div style={{ 
          width: 32, 
          height: 32, 
          border: '3px solid var(--stone-200)', 
          borderTopColor: 'var(--brand-rot)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }} />
        <p style={{ marginTop: 12, fontFamily: 'var(--font-body)', fontSize: 14 }}>Загрузка отзывов...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]" style={{ color: 'var(--brand-rot)' }}>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 14 }}>{error}</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ 
          fontFamily: 'var(--font-display)', 
          fontSize: 32, 
          fontWeight: 800, 
          color: 'var(--fg-1)',
          margin: 0
        }}>
          Отзывы клиентов
        </h1>
        <p style={{ 
          fontFamily: 'var(--font-body)', 
          fontSize: 14, 
          color: 'var(--fg-2)',
          marginTop: 8
        }}>
          {reviews.length} {reviews.length === 1 ? 'отзыв' : 'отзывов'}
        </p>
      </div>

      {/* Reviews List */}
      {reviews.length === 0 ? (
        <div style={{ 
          textAlign: 'center', 
          padding: '48px 16px', 
          background: 'var(--paper-sunk)', 
          borderRadius: 6,
          border: '1px dashed var(--stone-200)'
        }}>
          <p style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-body)', fontSize: 14 }}>
            Отзывов пока нет
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {reviews.map((review) => (
            <ReviewCard key={review.id} review={review} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {reviews.length > pageSize && (
        <div style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          alignItems: 'center', 
          gap: 8,
          marginTop: 32
        }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--fg-1)',
              background: 'var(--paper-raised)',
              border: '1px solid var(--stone-200)',
              borderRadius: 4,
              padding: '8px 16px',
              cursor: page === 1 ? 'not-allowed' : 'pointer',
              opacity: page === 1 ? 0.5 : 1
            }}
          >
            Назад
          </button>
          <span style={{
            fontFamily: 'var(--font-body)',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--paper-raised)',
            background: 'var(--brand-rot)',
            border: '1px solid var(--brand-rot)',
            borderRadius: 4,
            padding: '8px 16px'
          }}>
            {page}
          </span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={reviews.length < pageSize}
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--fg-1)',
              background: 'var(--paper-raised)',
              border: '1px solid var(--stone-200)',
              borderRadius: 4,
              padding: '8px 16px',
              cursor: reviews.length < pageSize ? 'not-allowed' : 'pointer',
              opacity: reviews.length < pageSize ? 0.5 : 1
            }}
          >
            Вперёд
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewCard({ review }: { review: Review }) {
  const platformColors: Record<string, string> = {
    ozon: '#005BFF',
    wb: '#CB11AB',
    email: '#0D199E'
  };

  return (
    <div style={{ 
      background: 'var(--paper-raised)', 
      border: '1px solid var(--stone-100)', 
      borderRadius: 6,
      padding: 16,
      boxShadow: '0 1px 2px rgba(26,21,25,.05)'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'flex-start',
        marginBottom: 12
      }}>
        <div>
          <p style={{ 
            fontFamily: 'var(--font-body)', 
            fontSize: 14, 
            fontWeight: 600, 
            color: 'var(--fg-1)',
            margin: 0
          }}>
            {review.author}
          </p>
          <p style={{ 
            fontFamily: 'var(--font-narrow)', 
            fontSize: 12, 
            color: 'var(--fg-3)',
            margin: '4px 0 0 0'
          }}>
            {new Date(review.createdAt).toLocaleDateString('ru-RU', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>
        
        {review.platform && (
          <span style={{
            fontFamily: 'var(--font-narrow)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--paper-raised)',
            padding: '4px 8px',
            borderRadius: 999,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            background: platformColors[review.platform] || 'var(--stone-400)'
          }}>
            {review.platform}
          </span>
        )}
      </div>

      {/* Star Rating */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 12 }}>
        {[1, 2, 3, 4, 5].map((star) => (
          <span
            key={star}
            style={{ 
              color: star <= review.rating ? 'var(--brand-gold)' : 'var(--stone-200)',
              fontSize: 16
            }}
          >
            ★
          </span>
        ))}
      </div>
      
      <p style={{ 
        fontFamily: 'var(--font-body)', 
        fontSize: 14, 
        color: 'var(--fg-1)',
        lineHeight: 1.6,
        margin: 0
      }}>
        {review.comment}
      </p>
    </div>
  );
}

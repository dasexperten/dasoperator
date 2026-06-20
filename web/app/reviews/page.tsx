import React, { useState, useEffect } from 'react';
import { ReviewCard } from '../../components/reviews/review-card';
import './reviews-page.css';

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

interface Stats {
  total: number;
  averageRating: number;
  positive: number;
  negative: number;
  neutral: number;
}

export function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    platform: 'all',
    rating: 'all',
    search: '',
  });
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    fetchReviews();
  }, [filters, page]);

  const fetchReviews = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        platform: filters.platform,
        rating: filters.rating,
        search: filters.search,
        page: page.toString(),
        limit: pageSize.toString(),
      });

      const response = await fetch(`/api/reviews?${params}`);
      const data = await response.json();
      
      setReviews(data.reviews || []);
      setStats(data.stats || null);
    } catch (error) {
      console.error('Failed to fetch reviews:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (key: string, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(1);
  };

  return (
    <div className="reviews-page">
      <header className="reviews-header">
        <h1 className="reviews-title">Отзывы клиентов</h1>
        <p className="reviews-subtitle">
          Управление отзывами с маркетплейсов и прямых каналов
        </p>
      </header>

      {stats && (
        <div className="stats-bar">
          <div className="stat-card">
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">Всего отзывов</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.averageRating.toFixed(1)}</div>
            <div className="stat-label">Средний рейтинг</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: 'var(--stat-positive)' }}>
              {stats.positive}
            </div>
            <div className="stat-label">Положительные</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: 'var(--stat-negative)' }}>
              {stats.negative}
            </div>
            <div className="stat-label">Отрицательные</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: 'var(--stat-neutral)' }}>
              {stats.neutral}
            </div>
            <div className="stat-label">Нейтральные</div>
          </div>
        </div>
      )}

      <div className="filter-bar">
        <div className="filter-group">
          <label className="filter-label" htmlFor="platform-filter">
            Платформа
          </label>
          <select
            id="platform-filter"
            className="filter-select"
            value={filters.platform}
            onChange={(e) => handleFilterChange('platform', e.target.value)}
          >
            <option value="all">Все платформы</option>
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="email">Email</option>
          </select>
        </div>

        <div className="filter-group">
          <label className="filter-label" htmlFor="rating-filter">
            Рейтинг
          </label>
          <select
            id="rating-filter"
            className="filter-select"
            value={filters.rating}
            onChange={(e) => handleFilterChange('rating', e.target.value)}
          >
            <option value="all">Все рейтинги</option>
            <option value="5">5 звезд</option>
            <option value="4">4 звезды</option>
            <option value="3">3 звезды</option>
            <option value="2">2 звезды</option>
            <option value="1">1 звезда</option>
          </select>
        </div>

        <div className="filter-group">
          <label className="filter-label" htmlFor="search-input">
            Поиск
          </label>
          <input
            id="search-input"
            type="search"
            className="filter-input"
            placeholder="Поиск по тексту отзыва..."
            value={filters.search}
            onChange={(e) => handleFilterChange('search', e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="reviews-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="review-card" style={{ opacity: 0.5 }}>
              <div className="review-header">
                <div className="review-meta">
                  <div className="review-author" style={{ width: 120, height: 16, background: 'var(--stone-200)' }} />
                  <div className="review-date" style={{ width: 80, height: 12, background: 'var(--stone-200)' }} />
                </div>
              </div>
              <div style={{ width: 100, height: 16, background: 'var(--stone-200)', marginBottom: 12 }} />
              <div style={{ width: '100%', height: 60, background: 'var(--stone-200)' }} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="reviews-grid">
            {reviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </div>

          {reviews.length === 0 && (
            <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--fg-3)' }}>
              Отзывы не найдены
            </div>
          )}

          <nav className="pagination" aria-label="Pagination">
            <button
              className="pagination-btn"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              aria-label="Previous page"
            >
              ←
            </button>
            <span className="pagination-btn pagination-btn--active">
              {page}
            </span>
            <button
              className="pagination-btn"
              onClick={() => setPage(p => p + 1)}
              disabled={reviews.length < pageSize}
              aria-label="Next page"
            >
              →
            </button>
          </nav>
        </>
      )}
    </div>
  );
}

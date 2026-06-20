'use client';

import React, { useState, useEffect } from 'react';

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

  const renderStars = (rating: number) => {
    return Array.from({ length: 5 }, (_, i) => (
      <span key={i} style={{ color: i < rating ? '#FEF004' : '#C9C1B0' }}>
        ★
      </span>
    ));
  };

  return (
    <div style={{ minHeight: '100vh', background: '#FBFAF6', padding: '32px' }}>
      <header style={{ marginBottom: '32px' }}>
        <h1 style={{ 
          fontSize: '32px', 
          fontWeight: 800, 
          color: '#1A1519',
          margin: '0 0 8px 0'
        }}>
          Отзывы клиентов
        </h1>
        <p style={{ 
          fontSize: '16px', 
          color: '#4A4238',
          margin: 0
        }}>
          Управление отзывами с маркетплейсов и прямых каналов
        </p>
      </header>

      {stats && (
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: '16px',
          marginBottom: '32px'
        }}>
          <div style={{ 
            background: '#FFFFFF', 
            border: '1px solid rgba(26,21,25,0.08)',
            borderRadius: '6px',
            padding: '16px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '32px', fontWeight: 700, color: '#1A1519' }}>
              {stats.total}
            </div>
            <div style={{ 
              fontSize: '12px', 
              color: '#6E6558',
              textTransform: 'uppercase',
              letterSpacing: '0.18em'
            }}>
              Всего отзывов
            </div>
          </div>
          <div style={{ 
            background: '#FFFFFF', 
            border: '1px solid rgba(26,21,25,0.08)',
            borderRadius: '6px',
            padding: '16px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '32px', fontWeight: 700, color: '#1A1519' }}>
              {stats.averageRating.toFixed(1)}
            </div>
            <div style={{ 
              fontSize: '12px', 
              color: '#6E6558',
              textTransform: 'uppercase',
              letterSpacing: '0.18em'
            }}>
              Средний рейтинг
            </div>
          </div>
          <div style={{ 
            background: '#FFFFFF', 
            border: '1px solid rgba(26,21,25,0.08)',
            borderRadius: '6px',
            padding: '16px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '32px', fontWeight: 700, color: '#2E7D4F' }}>
              {stats.positive}
            </div>
            <div style={{ 
              fontSize: '12px', 
              color: '#6E6558',
              textTransform: 'uppercase',
              letterSpacing: '0.18em'
            }}>
              Положительные
            </div>
          </div>
          <div style={{ 
            background: '#FFFFFF', 
            border: '1px solid rgba(26,21,25,0.08)',
            borderRadius: '6px',
            padding: '16px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '32px', fontWeight: 700, color: '#E5202C' }}>
              {stats.negative}
            </div>
            <div style={{ 
              fontSize: '12px', 
              color: '#6E6558',
              textTransform: 'uppercase',
              letterSpacing: '0.18em'
            }}>
              Отрицательные
            </div>
          </div>
          <div style={{ 
            background: '#FFFFFF', 
            border: '1px solid rgba(26,21,25,0.08)',
            borderRadius: '6px',
            padding: '16px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '32px', fontWeight: 700, color: '#C77A00' }}>
              {stats.neutral}
            </div>
            <div style={{ 
              fontSize: '12px', 
              color: '#6E6558',
              textTransform: 'uppercase',
              letterSpacing: '0.18em'
            }}>
              Нейтральные
            </div>
          </div>
        </div>
      )}

      <div style={{ 
        display: 'flex', 
        flexWrap: 'wrap', 
        gap: '12px',
        marginBottom: '32px',
        padding: '16px',
        background: '#F3F0E8',
        borderRadius: '6px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ 
            fontSize: '11px', 
            fontWeight: 700, 
            color: '#6E6558',
            textTransform: 'uppercase',
            letterSpacing: '0.18em'
          }}>
            Платформа
          </label>
          <select
            value={filters.platform}
            onChange={(e) => handleFilterChange('platform', e.target.value)}
            style={{
              fontSize: '14px',
              color: '#1A1519',
              background: '#FFFFFF',
              border: '1px solid rgba(26,21,25,0.14)',
              borderRadius: '4px',
              padding: '8px 12px',
              minHeight: '44px'
            }}
          >
            <option value="all">Все платформы</option>
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="email">Email</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ 
            fontSize: '11px', 
            fontWeight: 700, 
            color: '#6E6558',
            textTransform: 'uppercase',
            letterSpacing: '0.18em'
          }}>
            Рейтинг
          </label>
          <select
            value={filters.rating}
            onChange={(e) => handleFilterChange('rating', e.target.value)}
            style={{
              fontSize: '14px',
              color: '#1A1519',
              background: '#FFFFFF',
              border: '1px solid rgba(26,21,25,0.14)',
              borderRadius: '4px',
              padding: '8px 12px',
              minHeight: '44px'
            }}
          >
            <option value="all">Все рейтинги</option>
            <option value="5">5 звезд</option>
            <option value="4">4 звезды</option>
            <option value="3">3 звезды</option>
            <option value="2">2 звезды</option>
            <option value="1">1 звезда</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ 
            fontSize: '11px', 
            fontWeight: 700, 
            color: '#6E6558',
            textTransform: 'uppercase',
            letterSpacing: '0.18em'
          }}>
            Поиск
          </label>
          <input
            type="search"
            placeholder="Поиск по тексту отзыва..."
            value={filters.search}
            onChange={(e) => handleFilterChange('search', e.target.value)}
            style={{
              fontSize: '14px',
              color: '#1A1519',
              background: '#FFFFFF',
              border: '1px solid rgba(26,21,25,0.14)',
              borderRadius: '4px',
              padding: '8px 12px',
              minHeight: '44px',
              minWidth: '200px'
            }}
          />
        </div>
      </div>

      {loading ? (
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '16px'
        }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ 
              background: '#FFFFFF', 
              border: '1px solid rgba(26,21,25,0.08)',
              borderRadius: '6px',
              padding: '16px',
              opacity: 0.5
            }}>
              <div style={{ width: 120, height: 16, background: '#C9C1B0', marginBottom: 8 }} />
              <div style={{ width: 80, height: 12, background: '#C9C1B0', marginBottom: 12 }} />
              <div style={{ width: 100, height: 16, background: '#C9C1B0', marginBottom: 12 }} />
              <div style={{ width: '100%', height: 60, background: '#C9C1B0' }} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '16px'
          }}>
            {reviews.map((review) => (
              <div key={review.id} style={{ 
                background: '#FFFFFF', 
                border: '1px solid rgba(26,21,25,0.08)',
                borderRadius: '6px',
                padding: '16px',
                boxShadow: '0 1px 2px rgba(26,21,25,.05), 0 0 0 1px rgba(26,21,25,0.08)'
              }}>
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'flex-start',
                  marginBottom: '12px'
                }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#1A1519' }}>
                      {review.author}
                    </div>
                    <div style={{ fontSize: '12px', color: '#6E6558' }}>
                      {new Date(review.date).toLocaleDateString('ru-RU')}
                    </div>
                  </div>
                  <span style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#FFFFFF',
                    padding: '4px 8px',
                    borderRadius: '999px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    background: review.platform === 'ozon' ? '#005BFF' : 
                               review.platform === 'wb' ? '#CB11AB' : '#0D199E'
                  }}>
                    {review.platform.toUpperCase()}
                  </span>
                </div>

                <div style={{ marginBottom: '12px' }}>
                  {renderStars(review.rating)}
                </div>

                <p style={{ 
                  fontSize: '16px', 
                  color: '#1A1519',
                  lineHeight: 1.7,
                  margin: '0 0 12px 0'
                }}>
                  {review.text}
                </p>

                {review.answer && (
                  <div style={{ 
                    background: '#F3F0E8',
                    borderLeft: '3px solid #E5202C',
                    padding: '12px',
                    borderRadius: '0 4px 4px 0',
                    marginTop: '12px'
                  }}>
                    <div style={{ 
                      fontSize: '11px', 
                      fontWeight: 700, 
                      color: '#E5202C',
                      textTransform: 'uppercase',
                      letterSpacing: '0.18em',
                      marginBottom: '8px'
                    }}>
                      Наш ответ
                    </div>
                    <p style={{ 
                      fontSize: '14px', 
                      color: '#4A4238',
                      lineHeight: 1.55,
                      margin: 0
                    }}>
                      {review.answer}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>

          {reviews.length === 0 && (
            <div style={{ 
              textAlign: 'center', 
              padding: '64px', 
              color: '#6E6558' 
            }}>
              Отзывы не найдены
            </div>
          )}

          <nav style={{ 
            display: 'flex', 
            justifyContent: 'center', 
            alignItems: 'center', 
            gap: '8px',
            marginTop: '32px'
          }} aria-label="Pagination">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              aria-label="Previous page"
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: '#1A1519',
                background: '#FFFFFF',
                border: '1px solid rgba(26,21,25,0.14)',
                borderRadius: '4px',
                padding: '8px 12px',
                minWidth: '44px',
                minHeight: '44px',
                cursor: page === 1 ? 'not-allowed' : 'pointer',
                opacity: page === 1 ? 0.5 : 1
              }}
            >
              ←
            </button>
            <span style={{
              fontSize: '14px',
              fontWeight: 600,
              color: '#FFFFFF',
              background: '#E5202C',
              border: '1px solid #E5202C',
              borderRadius: '4px',
              padding: '8px 12px',
              minWidth: '44px',
              minHeight: '44px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {page}
            </span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={reviews.length < pageSize}
              aria-label="Next page"
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: '#1A1519',
                background: '#FFFFFF',
                border: '1px solid rgba(26,21,25,0.14)',
                borderRadius: '4px',
                padding: '8px 12px',
                minWidth: '44px',
                minHeight: '44px',
                cursor: reviews.length < pageSize ? 'not-allowed' : 'pointer',
                opacity: reviews.length < pageSize ? 0.5 : 1
              }}
            >
              →
            </button>
          </nav>
        </>
      )}
    </div>
  );
}

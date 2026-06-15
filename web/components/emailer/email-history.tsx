'use client';

import { useState, useEffect } from 'react';
import { Search, Mail, Paperclip, RefreshCw, Loader2, AlertCircle, Reply } from 'lucide-react';
import { getEmailHistory, type EmailThread } from '@/lib/api';
import ReplyModal from './reply-modal';

export default function EmailHistory() {
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('newer_than:30d');
  const [selectedThread, setSelectedThread] = useState<EmailThread | null>(null);
  const [showReplyModal, setShowReplyModal] = useState(false);

  const fetchHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getEmailHistory(searchQuery);
      if (result.success && result.result) {
        setThreads(result.result.threads || []);
      } else {
        setError('Failed to fetch email history');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  const handleSearch = () => {
    fetchHistory();
  };

  const handleReply = (thread: EmailThread) => {
    setSelectedThread(thread);
    setShowReplyModal(true);
  };

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Search Bar */}
      <div className="mb-6 flex gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Gmail search query (e.g., newer_than:30d, from:client@example.com)"
            className="w-full pl-10 pr-4 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Search
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-red-600" />
          <span className="text-red-800">{error}</span>
        </div>
      )}

      {/* Email List */}
      <div className="bg-card border border-border rounded-lg shadow-sm">
        {loading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">Loading emails...</p>
          </div>
        ) : threads.length === 0 ? (
          <div className="p-8 text-center">
            <Mail className="h-12 w-12 mx-auto text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">No emails found</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {threads.map((thread) => (
              <div
                key={thread.thread_id}
                className="p-4 hover:bg-secondary/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-medium text-foreground truncate">
                        {thread.subject || '(No subject)'}
                      </h3>
                      {thread.has_attachments && (
                        <Paperclip className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mb-1">
                      From: {thread.from}
                    </p>
                    <p className="text-xs text-muted-foreground mb-1">
                      To: {thread.to}
                    </p>
                    <p className="text-sm text-foreground line-clamp-2">
                      {thread.snippet}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(thread.date)}
                    </span>
                    <button
                      onClick={() => handleReply(thread)}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-primary hover:text-primary/80 border border-primary/20 rounded hover:bg-primary/5"
                    >
                      <Reply className="h-3 w-3" />
                      Reply
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reply Modal */}
      {showReplyModal && selectedThread && (
        <ReplyModal
          thread={selectedThread}
          onClose={() => {
            setShowReplyModal(false);
            setSelectedThread(null);
          }}
          onSent={() => {
            setShowReplyModal(false);
            setSelectedThread(null);
            fetchHistory();
          }}
        />
      )}
    </div>
  );
}

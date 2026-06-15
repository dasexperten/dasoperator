'use client';

import { useState } from 'react';
import { X, Send, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { sendEmail, type EmailThread, type SendEmailParams } from '@/lib/api';

interface ReplyModalProps {
  thread: EmailThread;
  onClose: () => void;
  onSent: () => void;
}

export default function ReplyModal({ thread, onClose, onSent }: ReplyModalProps) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSend = async () => {
    if (!body.trim()) {
      setError('Reply body is required');
      return;
    }

    setError(null);
    setSending(true);

    try {
      const params: SendEmailParams = {
        action: 'reply',
        thread_id: thread.thread_id,
        body_plain: body,
      };

      const result = await sendEmail(params);

      if (result.success) {
        setSuccess('Reply sent successfully');
        setTimeout(() => {
          onSent();
        }, 1500);
      } else {
        setError(result.errors?.[0]?.message || 'Failed to send reply');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Reply</h2>
            <p className="text-sm text-muted-foreground">
              Re: {thread.subject || '(No subject)'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Success/Error Messages */}
          {success && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-sm text-green-800">{success}</span>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-600" />
              <span className="text-sm text-red-800">{error}</span>
            </div>
          )}

          {/* Original Thread Info */}
          <div className="mb-4 p-3 bg-secondary rounded-lg">
            <p className="text-xs text-muted-foreground mb-1">
              <span className="font-medium">From:</span> {thread.from}
            </p>
            <p className="text-xs text-muted-foreground mb-1">
              <span className="font-medium">To:</span> {thread.to}
            </p>
            <p className="text-xs text-muted-foreground mb-1">
              <span className="font-medium">Date:</span> {thread.date}
            </p>
            <p className="text-sm text-foreground mt-2">{thread.snippet}</p>
          </div>

          {/* Reply Body */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Your Reply
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your reply..."
              rows={8}
              className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-y"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            disabled={sending}
            className="px-4 py-2 text-sm font-medium text-foreground bg-secondary border border-border rounded-md hover:bg-secondary/80 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || !body.trim()}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Send Reply
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useRef } from 'react';
import { Send, Paperclip, X, Loader2, AlertCircle, CheckCircle2, Save } from 'lucide-react';
import { sendEmail, type SendEmailParams } from '@/lib/api';

interface Attachment {
  file: File;
  url?: string;
  uploading: boolean;
  progress: number;
}

export default function ComposeEmail() {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [bodyFormat, setBodyFormat] = useState<'plain' | 'html'>('plain');
  const [from, setFrom] = useState('eurasia@dasexperten.de');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const senderOptions = [
    { value: 'eurasia@dasexperten.de', label: 'Eurasia Team' },
    { value: 'emea@dasexperten.de', label: 'EMEA Team' },
    { value: 'marketing@dasexperten.de', label: 'Marketing' },
    { value: 'sales@dasexperten.de', label: 'Sales' },
    { value: 'support@dasexperten.de', label: 'Support' },
  ];

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newAttachments = files.map((file) => ({
      file,
      uploading: false,
      progress: 0,
    }));
    setAttachments((prev) => [...prev, ...newAttachments]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async (draftOnly: boolean) => {
    if (!to && !draftOnly) {
      setError('Recipient is required');
      return;
    }
    if (!subject) {
      setError('Subject is required');
      return;
    }
    if (!body) {
      setError('Body is required');
      return;
    }

    setError(null);
    setSuccess(null);

    if (draftOnly) {
      setSavingDraft(true);
    } else {
      setSending(true);
    }

    try {
      const params: SendEmailParams = {
        action: 'send',
        recipient: to,
        subject,
        body_plain: bodyFormat === 'plain' ? body : undefined,
        body_html: bodyFormat === 'html' ? body : undefined,
        from,
        draft_only: draftOnly,
        attachments: attachments.filter((a) => a.url).map((a) => a.url!),
      };

      const result = await sendEmail(params);

      if (result.success) {
        if (draftOnly) {
          setSuccess(`Draft created successfully`);
        } else {
          setSuccess(`Email sent successfully`);
        }
        // Reset form
        setTo('');
        setCc('');
        setBcc('');
        setSubject('');
        setBody('');
        setAttachments([]);
      } else {
        setError(result.error || 'Failed to send email');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSending(false);
      setSavingDraft(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Success/Error Messages */}
      {success && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          <span className="text-green-800">{success}</span>
          <button onClick={() => setSuccess(null)} className="ml-auto">
            <X className="h-4 w-4 text-green-600" />
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-red-600" />
          <span className="text-red-800">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="h-4 w-4 text-red-600" />
          </button>
        </div>
      )}

      {/* Email Form */}
      <div className="bg-card border border-border rounded-lg shadow-sm">
        {/* From */}
        <div className="border-b border-border px-4 py-3">
          <label className="block text-sm font-medium text-foreground mb-1">From</label>
          <select
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {senderOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} &lt;{option.value}&gt;
              </option>
            ))}
          </select>
        </div>

        {/* To */}
        <div className="border-b border-border px-4 py-3">
          <label className="block text-sm font-medium text-foreground mb-1">To</label>
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="recipient@example.com"
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* CC */}
        <div className="border-b border-border px-4 py-3">
          <label className="block text-sm font-medium text-foreground mb-1">CC</label>
          <input
            type="email"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="cc@example.com"
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* BCC */}
        <div className="border-b border-border px-4 py-3">
          <label className="block text-sm font-medium text-foreground mb-1">BCC</label>
          <input
            type="email"
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
            placeholder="bcc@example.com"
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* Subject */}
        <div className="border-b border-border px-4 py-3">
          <label className="block text-sm font-medium text-foreground mb-1">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Email subject"
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* Body Format Toggle */}
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-4">
            <label className="block text-sm font-medium text-foreground">Format</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setBodyFormat('plain')}
                className={`px-3 py-1 text-sm rounded-md ${
                  bodyFormat === 'plain'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
              >
                Plain Text
              </button>
              <button
                type="button"
                onClick={() => setBodyFormat('html')}
                className={`px-3 py-1 text-sm rounded-md ${
                  bodyFormat === 'html'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
              >
                HTML
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={bodyFormat === 'plain' ? 'Write your email...' : '<p>Write your email...</p>'}
            rows={12}
            className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-y"
          />
        </div>

        {/* Attachments */}
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-foreground">Attachments</label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 text-sm text-primary hover:text-primary/80"
            >
              <Paperclip className="h-4 w-4" />
              Add file
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          {attachments.length > 0 && (
            <div className="space-y-2">
              {attachments.map((attachment, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 bg-secondary rounded-md"
                >
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-foreground flex-1 truncate">
                    {attachment.file.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {(attachment.file.size / 1024).toFixed(1)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="border-t border-border px-4 py-3 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => handleSend(true)}
            disabled={savingDraft || sending}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-foreground bg-secondary border border-border rounded-md hover:bg-secondary/80 disabled:opacity-50"
          >
            {savingDraft ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Draft
          </button>
          <button
            type="button"
            onClick={() => handleSend(false)}
            disabled={sending || savingDraft}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

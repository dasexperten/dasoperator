'use client';

import { useState, useRef, useEffect } from 'react';
import { MessageSquare, Send, X, Loader2, ExternalLink } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  actions?: Array<{ name: string; result: unknown }>;
}

interface ChatWidgetProps {
  apiUrl?: string;
  token?: string;
}

// =============================================================================
// Helper — generate unique ID
// =============================================================================
function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

// =============================================================================
// Main Component
// =============================================================================
export default function DasKompanion({ apiUrl = 'https://dasoperator-api.dasexperten.workers.dev', token }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------
  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(`${apiUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: userMessage.content,
          history: messages.slice(-10).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const data = await response.json();

      if (data.success && data.result) {
        const assistantMessage: ChatMessage = {
          id: generateId(),
          role: 'assistant',
          content: data.result.reply,
          timestamp: new Date(),
          actions: data.result.actions,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } else {
        // Error
        const errorMessage: ChatMessage = {
          id: generateId(),
          role: 'assistant',
          content: 'Sorry, I encountered an error. Please try again.',
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      }
    } catch (error) {
      console.error('[Das-Kompanion] Error:', error);
      const errorMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: 'Network error. Please check your connection and try again.',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Handle Enter key
  // ---------------------------------------------------------------------------
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ---------------------------------------------------------------------------
  // Format action results for display
  // ---------------------------------------------------------------------------
  const formatAction = (action: { name: string; result: unknown }) => {
    const result = action.result as Record<string, unknown>;

    if (result.error) {
      return (
        <div className="text-sm text-red-500 mt-2 p-2 bg-red-50 rounded">
          {result.error as string}
        </div>
      );
    }

    // Format based on action type
    switch (action.name) {
      case 'search_operations': {
        const ops = (result.operations as Array<Record<string, unknown>>)?.slice(0, 5) || [];
        return (
          <div className="mt-2 p-2 bg-gray-50 rounded text-sm">
            <div className="font-semibold mb-1">Operations found:</div>
            {ops.map((op, i) => (
              <div key={i} className="flex justify-between py-1 border-b border-gray-200 last:border-0">
                <span>{(op.reference as string) || (op.id as string)?.slice(0, 8)}</span>
                <span className="text-gray-500">{op.status as string}</span>
                <a
                  href={`/operations/${op.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  <ExternalLink size={12} />
                </a>
              </div>
            ))}
          </div>
        );
      }

      case 'search_partners': {
        const partners = (result.partners as Array<Record<string, unknown>>)?.slice(0, 5) || [];
        return (
          <div className="mt-2 p-2 bg-gray-50 rounded text-sm">
            <div className="font-semibold mb-1">Partners found:</div>
            {partners.map((p, i) => (
              <div key={i} className="flex justify-between py-1 border-b border-gray-200 last:border-0">
                <span>{p.trade_name as string}</span>
                <span className="text-gray-500">{p.partner_type as string}</span>
                <a
                  href={`/partners/${p.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  <ExternalLink size={12} />
                </a>
              </div>
            ))}
          </div>
        );
      }

      case 'search_products': {
        const products = (result.products as Array<Record<string, unknown>>)?.slice(0, 5) || [];
        return (
          <div className="mt-2 p-2 bg-gray-50 rounded text-sm">
            <div className="font-semibold mb-1">Products found:</div>
            {products.map((p, i) => (
              <div key={i} className="flex justify-between py-1 border-b border-gray-200 last:border-0">
                <span>{p.product_name as string}</span>
                <span className="text-gray-500">{p.category as string}</span>
                <a
                  href={`/products/${p.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  <ExternalLink size={12} />
                </a>
              </div>
            ))}
          </div>
        );
      }

      default:
        return (
          <div className="mt-2 p-2 bg-gray-50 rounded text-sm">
            <pre className="whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre>
          </div>
        );
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-105"
        style={{
          backgroundColor: 'var(--brand-schwarz)',
          color: 'var(--paper)',
        }}
        title="Das-Kompanion"
      >
        {isOpen ? <X size={24} /> : <MessageSquare size={24} />}
      </button>

      {/* Chat window */}
      {isOpen && (
        <div
          className="fixed bottom-24 right-6 z-50 w-96 h-[500px] flex flex-col shadow-2xl rounded-lg overflow-hidden"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          {/* Header */}
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{
              backgroundColor: 'var(--brand-schwarz)',
              color: 'var(--paper)',
            }}
          >
            <div className="flex items-center gap-2">
              <MessageSquare size={18} />
              <span className="font-semibold">Das-Kompanion</span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="opacity-70 hover:opacity-100"
            >
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-gray-500 mt-8">
                <MessageSquare size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">Ask me anything about your ERP data</p>
                <p className="text-xs mt-1 text-gray-400">
                  Search operations, partners, products, or get insights
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                    msg.role === 'user'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 text-gray-900'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  {msg.actions?.map((action, i) => (
                    <div key={i}>{formatAction(action)}</div>
                  ))}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 px-3 py-2 rounded-lg">
                  <Loader2 size={16} className="animate-spin text-gray-500" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div
            className="px-4 py-3 border-t"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about operations, partners, products..."
                className="flex-1 px-3 py-2 text-sm rounded border focus:outline-none focus:ring-2 focus:ring-blue-500"
                style={{
                  borderColor: 'var(--border-hairline)',
                  backgroundColor: 'var(--paper)',
                }}
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
                className="px-3 py-2 rounded transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: 'var(--brand-schwarz)',
                  color: 'var(--paper)',
                }}
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { Plus, Trash2, Loader2, AlertCircle, CheckCircle2, Shield, Mail, ArrowRight, Trash } from 'lucide-react';
import { getEmailRules, createEmailRule, deleteEmailRule, type EmailRule } from '@/lib/api';

export default function EmailRules() {
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newRule, setNewRule] = useState({
    rule_type: 'forward' as 'forward' | 'auto_delete' | 'archive',
    pattern: '',
    target: '',
  });
  const [creating, setCreating] = useState(false);

  const fetchRules = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getEmailRules();
      if (result.success && result.result) {
        setRules(result.result.rules || []);
      } else {
        setError('Failed to fetch email rules');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const handleCreate = async () => {
    if (!newRule.pattern) {
      setError('Pattern is required');
      return;
    }
    if (newRule.rule_type === 'forward' && !newRule.target) {
      setError('Target email is required for forwarding rules');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const result = await createEmailRule(newRule);
      if (result.success) {
        setSuccess('Rule created successfully');
        setShowCreateForm(false);
        setNewRule({ rule_type: 'forward', pattern: '', target: '' });
        fetchRules();
      } else {
        setError('Failed to create rule');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this rule?')) {
      return;
    }

    try {
      const result = await deleteEmailRule(id);
      if (result.success) {
        setSuccess('Rule deleted successfully');
        fetchRules();
      } else {
        setError('Failed to delete rule');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const getRuleTypeIcon = (type: string) => {
    switch (type) {
      case 'forward':
        return <ArrowRight className="h-4 w-4" />;
      case 'auto_delete':
        return <Trash className="h-4 w-4" />;
      case 'archive':
        return <Shield className="h-4 w-4" />;
      default:
        return <Mail className="h-4 w-4" />;
    }
  };

  const getRuleTypeLabel = (type: string) => {
    switch (type) {
      case 'forward':
        return 'Forward';
      case 'auto_delete':
        return 'Auto Delete';
      case 'archive':
        return 'Archive';
      default:
        return type;
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-foreground">Email Rules</h2>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Rule
        </button>
      </div>

      {/* Success/Error Messages */}
      {success && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          <span className="text-green-800">{success}</span>
          <button onClick={() => setSuccess(null)} className="ml-auto">
            <span className="text-green-600 hover:text-green-800">×</span>
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-red-600" />
          <span className="text-red-800">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <span className="text-red-600 hover:text-red-800">×</span>
          </button>
        </div>
      )}

      {/* Create Form */}
      {showCreateForm && (
        <div className="mb-6 bg-card border border-border rounded-lg p-4">
          <h3 className="text-md font-medium text-foreground mb-4">Create New Rule</h3>
          
          <div className="space-y-4">
            {/* Rule Type */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Rule Type
              </label>
              <div className="flex gap-3">
                {(['forward', 'auto_delete', 'archive'] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setNewRule({ ...newRule, rule_type: type })}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border ${
                      newRule.rule_type === type
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:bg-secondary'
                    }`}
                  >
                    {getRuleTypeIcon(type)}
                    {getRuleTypeLabel(type)}
                  </button>
                ))}
              </div>
            </div>

            {/* Pattern */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Pattern (sender email, domain, or subject contains)
              </label>
              <input
                type="text"
                value={newRule.pattern}
                onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })}
                placeholder="e.g., noreply@ozon.ru or subject:unsubscribe"
                className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {/* Target (for forward rules) */}
            {newRule.rule_type === 'forward' && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Forward To (email address)
                </label>
                <input
                  type="email"
                  value={newRule.target}
                  onChange={(e) => setNewRule({ ...newRule, target: e.target.value })}
                  placeholder="recipient@dasexperten.de"
                  className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setShowCreateForm(false)}
                className="px-4 py-2 text-sm font-medium text-foreground bg-secondary border border-border rounded-md hover:bg-secondary/80"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create Rule
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rules List */}
      <div className="bg-card border border-border rounded-lg shadow-sm">
        {loading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">Loading rules...</p>
          </div>
        ) : rules.length === 0 ? (
          <div className="p-8 text-center">
            <Shield className="h-12 w-12 mx-auto text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">No email rules configured</p>
            <p className="text-xs text-muted-foreground mt-1">
              Create a rule to automatically forward or delete emails
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="p-4 hover:bg-secondary/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-secondary rounded-md">
                      {getRuleTypeIcon(rule.rule_type)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-foreground">
                          {getRuleTypeLabel(rule.rule_type)}
                        </h3>
                        <span
                          className={`px-2 py-0.5 text-xs rounded-full ${
                            rule.enabled
                              ? 'bg-green-100 text-green-800'
                              : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {rule.enabled ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mb-1">
                        Pattern: <span className="font-mono">{rule.pattern}</span>
                      </p>
                      {rule.target && (
                        <p className="text-sm text-muted-foreground">
                          Target: <span className="font-mono">{rule.target}</span>
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(rule.id)}
                    className="p-2 text-muted-foreground hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                    title="Delete rule"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

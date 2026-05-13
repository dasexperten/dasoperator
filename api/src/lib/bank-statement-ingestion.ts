// =============================================================================
// Bank statement ingestion — daily Gmail → R2 → parser → bank_transactions
// =============================================================================
//
// Called from scheduled cron (hourly or daily).
// Workflow:
//   1. Load all active bank_statement_sources
//   2. For each source: search Gmail (emailer-bridge `find`) for new mail
//      from that address with attachments
//   3. For each attachment: download from R2, extract text, parse via DeepSeek
//   4. Insert into bank_transactions (idempotent via UNIQUE)
//   5. Log summary
//
// =============================================================================

import type { Env } from '../types';
import { parseStatement, insertTransactions, extractTextFromFile } from './bank-statement-parser';

interface IngestionStats {
  sources_checked: number;
  threads_found: number;
  attachments_processed: number;
  transactions_inserted: number;
  transactions_skipped: number;
  errors: number;
  per_source: Array<{
    email: string;
    company_abbreviation: string;
    threads: number;
    inserted: number;
    skipped: number;
    error?: string;
  }>;
}

export async function runBankStatementIngestion(env: Env): Promise<IngestionStats> {
  const stats: IngestionStats = {
    sources_checked: 0,
    threads_found: 0,
    attachments_processed: 0,
    transactions_inserted: 0,
    transactions_skipped: 0,
    errors: 0,
    per_source: [],
  };

  console.log('[bank-statement-ingestion] starting');

  // Load active sources
  const sources = await env.DB.prepare(
    `SELECT s.id, s.email, s.company_id, c.abbreviation AS company_abbreviation
       FROM bank_statement_sources s
       JOIN companies c ON c.id = s.company_id
      WHERE s.is_active = 1 AND s.deleted_at IS NULL`
  ).all<{ id: string; email: string; company_id: string; company_abbreviation: string }>();

  stats.sources_checked = sources.results?.length ?? 0;

  for (const source of sources.results ?? []) {
    const sourceStats = {
      email: source.email,
      company_abbreviation: source.company_abbreviation,
      threads: 0,
      inserted: 0,
      skipped: 0,
      error: undefined as string | undefined,
    };

    try {
      // Search Gmail via emailer-bridge service binding
      const findResp = await env.EMAILER.fetch('https://emailer/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'find',
          query: `from:${source.email} has:attachment newer_than:2d`,
          max_results: 10,
        }),
      });

      if (!findResp.ok) {
        sourceStats.error = `Gmail find HTTP ${findResp.status}`;
        stats.errors++;
        stats.per_source.push(sourceStats);
        continue;
      }

      const findResult = await findResp.json<{ threads?: Array<any> }>();
      const threads = findResult.threads ?? [];
      sourceStats.threads = threads.length;
      stats.threads_found += threads.length;

      for (const t of threads) {
        for (const a of t.attachments_resolved ?? []) {
          // Accept CSV/PDF/XLSX
          const lower = (a.filename || '').toLowerCase();
          const isAcceptable =
            lower.endsWith('.csv') ||
            lower.endsWith('.pdf') ||
            lower.endsWith('.xlsx') ||
            lower.endsWith('.xls') ||
            lower.endsWith('.txt');
          if (!isAcceptable || !a.r2_url) continue;

          // Dedup: check if we already ingested this attachment
          const exists = await env.DB.prepare(
            `SELECT COUNT(*) as cnt FROM bank_transactions
              WHERE raw_payload LIKE ?`
          ).bind(`%${a.filename}%`).first<{ cnt: number }>();
          // Crude dedup — relies on UNIQUE(external_id) for hard guarantee.
          // This LIKE check just avoids re-running DeepSeek on processed files.
          if (exists && exists.cnt > 0) continue;

          stats.attachments_processed++;

          // Download from R2 public URL
          const fileResp = await fetch(a.r2_url);
          if (!fileResp.ok) {
            sourceStats.error = `R2 fetch HTTP ${fileResp.status}`;
            stats.errors++;
            continue;
          }
          const bytes = new Uint8Array(await fileResp.arrayBuffer());

          // Extract text, parse, insert
          try {
            const text = await extractTextFromFile(bytes, a.mime_type ?? '', a.filename);
            if (text.length < 50) continue;

            const parsed = await parseStatement(env, text, a.filename);
            const summary = await insertTransactions(env, parsed, {
              company_id: source.company_id,
            });

            sourceStats.inserted += summary.inserted;
            sourceStats.skipped += summary.skipped;
            stats.transactions_inserted += summary.inserted;
            stats.transactions_skipped += summary.skipped;
            if (summary.errors > 0) stats.errors += summary.errors;
          } catch (e) {
            console.error('[bank-statement-ingestion] parse/insert error:', e);
            stats.errors++;
          }
        }
      }
    } catch (e) {
      sourceStats.error = e instanceof Error ? e.message : String(e);
      stats.errors++;
    }

    stats.per_source.push(sourceStats);
  }

  console.log(`[bank-statement-ingestion] complete: ${JSON.stringify(stats)}`);
  return stats;
}

// =============================================================================
// Heal action implementations
//
// Each action_type registered here corresponds to a row in auto_heal_recipes.
// Actions must be idempotent and safe to run multiple times — they should
// either succeed or fail cleanly, never leave partial state.
//
// Adding a new action: implement it in the switch, document its config shape,
// then insert a recipe row pointing at the action_type.
// =============================================================================

import type { Env } from '../types';

// Whitelist of tables that auto-healer is allowed to recreate when they go
// missing. Each entry maps table name → full CREATE TABLE + indexes SQL.
// Adding a table here is an explicit safety decision — only tables that are
// reference/metadata in nature (no irreplaceable data) belong here.
const RECREATABLE_TABLES: Record<string, string[]> = {
  bank_statement_files: [
    `CREATE TABLE IF NOT EXISTS bank_statement_files (
       id TEXT PRIMARY KEY,
       bank_account_id TEXT,
       source_type TEXT NOT NULL DEFAULT 'pdf_upload',
       filename TEXT,
       r2_key TEXT,
       file_size INTEGER,
       uploaded_at INTEGER NOT NULL,
       uploaded_by TEXT,
       period_from INTEGER,
       period_till INTEGER,
       rows_total INTEGER DEFAULT 0,
       rows_inserted INTEGER DEFAULT 0,
       rows_updated INTEGER DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'pending',
       error_message TEXT,
       raw_meta TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       deleted_at INTEGER
     )`,
    `CREATE INDEX IF NOT EXISTS idx_bsf_bank_account ON bank_statement_files(bank_account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bsf_uploaded_at ON bank_statement_files(uploaded_at DESC)`,
  ],
};

interface CreateKnownTableConfig {
  table_name: string;
}

async function actionCreateKnownTable(env: Env, config: CreateKnownTableConfig) {
  const tableName = config.table_name;
  if (!tableName) throw new Error('config.table_name is required');

  const stmts = RECREATABLE_TABLES[tableName];
  if (!stmts) throw new Error(`Table '${tableName}' is not in the recreate-whitelist`);

  // Check if table already exists (idempotent — heal already happened)
  const existing = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).bind(tableName).first<{ name: string }>();

  if (existing) {
    return { table: tableName, action: 'noop', reason: 'table_already_exists' };
  }

  const prepared = stmts.map(sql => env.DB.prepare(sql));
  await env.DB.batch(prepared);

  return {
    table: tableName,
    action: 'created',
    statements: stmts.length,
  };
}

export async function executeHealAction(
  env: Env,
  actionType: string,
  config: Record<string, unknown>,
): Promise<unknown> {
  switch (actionType) {
    case 'create_known_table':
      return actionCreateKnownTable(env, config as unknown as CreateKnownTableConfig);

    // Future actions:
    // case 'reset_stuck_task': return actionResetStuckTask(env, config);
    // case 'clear_kv_key':     return actionClearKvKey(env, config);
    // case 'trigger_resync':   return actionTriggerResync(env, config);

    default:
      throw new Error(`Unknown action_type: ${actionType}`);
  }
}

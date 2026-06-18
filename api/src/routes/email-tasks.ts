// =============================================================================
// Email Tasks — agent task conveyor + learning loop (Migration 0054)
// =============================================================================
// Turns the Emailer module into a TASKS command center:
//   scenarios (cron jobs) -> agent queue -> Safety Gate -> send (via emailer-bridge)
// and the learning loop: your edits -> lessons -> approved -> playbook canon.
//
// NOTHING here sends mail. Sending stays in /api/email (emailer-bridge).
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { draftReply } from '../lib/email-draft';

const r = new Hono<{ Bindings: Env }>();

const now = () => Math.floor(Date.now() / 1000);
const startOfTodayUtc = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

// ---------------------------------------------------------------------------
// SUMMARY — metric cards
// ---------------------------------------------------------------------------
r.get('/summary', async (c) => {
  try {
    const queue = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM email_agent_tasks WHERE status IN ('researching','draft_ready')"
    ).first<{ n: number }>();
    const gate = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM email_agent_tasks WHERE status = 'awaiting_ok'"
    ).first<{ n: number }>();
    const sentToday = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM email_agent_tasks WHERE status = 'sent' AND sent_at >= ?"
    ).bind(startOfTodayUtc()).first<{ n: number }>();
    const acc = await c.env.DB.prepare(
      'SELECT COALESCE(SUM(sent_clean),0) AS clean, COALESCE(SUM(edited),0) AS edited FROM email_scenarios'
    ).first<{ clean: number; edited: number }>();
    const pending = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM email_lessons WHERE status = 'pending'"
    ).first<{ n: number }>();

    const total = (acc?.clean ?? 0) + (acc?.edited ?? 0);
    const accuracy = total > 0 ? Math.round(((acc?.clean ?? 0) / total) * 100) : null;

    return ok(c, {
      in_queue: queue?.n ?? 0,
      awaiting_ok: gate?.n ?? 0,
      sent_today: sentToday?.n ?? 0,
      pending_lessons: pending?.n ?? 0,
      agent_accuracy: accuracy,
    });
  } catch (e) {
    return fail(c, 500, [{ code: 'summary_failed', message: String(e) }]);
  }
});

// ---------------------------------------------------------------------------
// SCENARIOS
// ---------------------------------------------------------------------------
r.get('/scenarios', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM email_scenarios ORDER BY enabled DESC, name ASC'
  ).all();
  const scenarios = (rows.results ?? []).map((s: any) => {
    const total = (s.sent_clean ?? 0) + (s.edited ?? 0);
    return { ...s, accuracy: total > 0 ? Math.round((s.sent_clean / total) * 100) : null };
  });
  return ok(c, scenarios);
});

r.patch('/scenarios/:id', async (c) => {
  const id = c.req.param('id');
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty patch ok */ }

  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const k of ['enabled', 'auto_learning'] as const) {
    if (typeof body[k] === 'boolean') { fields.push(`${k} = ?`); vals.push(body[k] ? 1 : 0); }
  }
  if (body.executor === 'worker' || body.executor === 'hermes') { fields.push('executor = ?'); vals.push(body.executor); }
  if (typeof body.schedule_cron === 'string') { fields.push('schedule_cron = ?'); vals.push(body.schedule_cron); }
  if (fields.length === 0) return fail(c, 422, [{ code: 'no_fields', message: 'Nothing to update' }]);

  fields.push('updated_at = ?'); vals.push(now()); vals.push(id);
  await c.env.DB.prepare(`UPDATE email_scenarios SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
  const updated = await c.env.DB.prepare('SELECT * FROM email_scenarios WHERE id = ?').bind(id).first();
  return ok(c, updated);
});

// ---------------------------------------------------------------------------
// QUEUE
// ---------------------------------------------------------------------------
r.get('/queue', async (c) => {
  const status = c.req.query('status');
  const sql = status
    ? 'SELECT t.*, s.name AS scenario_name FROM email_agent_tasks t LEFT JOIN email_scenarios s ON s.id = t.scenario_id WHERE t.status = ? ORDER BY t.created_at DESC LIMIT 100'
    : 'SELECT t.*, s.name AS scenario_name FROM email_agent_tasks t LEFT JOIN email_scenarios s ON s.id = t.scenario_id ORDER BY t.created_at DESC LIMIT 100';
  const stmt = status ? c.env.DB.prepare(sql).bind(status) : c.env.DB.prepare(sql);
  const rows = await stmt.all();
  return ok(c, rows.results ?? []);
});

// ---------------------------------------------------------------------------
// LESSONS
// ---------------------------------------------------------------------------
r.get('/lessons', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const rows = await c.env.DB.prepare(
    'SELECT l.*, s.name AS scenario_name FROM email_lessons l LEFT JOIN email_scenarios s ON s.id = l.scenario_id WHERE l.status = ? ORDER BY l.seen_count DESC, l.created_at DESC LIMIT 100'
  ).bind(status).all();
  return ok(c, rows.results ?? []);
});

r.post('/lessons/:id/approve', async (c) => {
  const id = c.req.param('id');
  const lesson = await c.env.DB.prepare('SELECT * FROM email_lessons WHERE id = ?').bind(id).first<any>();
  if (!lesson) return fail(c, 404, [{ code: 'not_found', message: 'Lesson not found' }]);
  if (lesson.status !== 'pending') return fail(c, 409, [{ code: 'already_decided', message: `Lesson is ${lesson.status}` }]);

  const t = now();
  const pbId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE email_lessons SET status = 'approved', decided_at = ?, decided_by = 'aram' WHERE id = ?"
    ).bind(t, id),
    c.env.DB.prepare(
      "INSERT INTO email_playbook (id, scenario_id, lesson, kind, active, source_lesson_id, approved_at, approved_by) VALUES (?, ?, ?, 'lesson', 1, ?, ?, 'aram')"
    ).bind(pbId, lesson.scenario_id, lesson.proposed, id, t),
  ]);
  return ok(c, { lesson_id: id, playbook_id: pbId, status: 'approved' });
});

r.post('/lessons/:id/reject', async (c) => {
  const id = c.req.param('id');
  const lesson = await c.env.DB.prepare('SELECT * FROM email_lessons WHERE id = ?').bind(id).first<any>();
  if (!lesson) return fail(c, 404, [{ code: 'not_found', message: 'Lesson not found' }]);
  if (lesson.status !== 'pending') return fail(c, 409, [{ code: 'already_decided', message: `Lesson is ${lesson.status}` }]);

  const t = now();
  const pbId = crypto.randomUUID();
  // Rejected lesson becomes a stop-phrase so the agent never proposes it again.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE email_lessons SET status = 'rejected', decided_at = ?, decided_by = 'aram' WHERE id = ?"
    ).bind(t, id),
    c.env.DB.prepare(
      "INSERT INTO email_playbook (id, scenario_id, lesson, kind, active, source_lesson_id, approved_at, approved_by) VALUES (?, ?, ?, 'stop_phrase', 1, ?, ?, 'aram')"
    ).bind(pbId, lesson.scenario_id, lesson.proposed, id, t),
  ]);
  return ok(c, { lesson_id: id, status: 'rejected', stop_phrase_id: pbId });
});

// ---------------------------------------------------------------------------
// PLAYBOOK (canon)
// ---------------------------------------------------------------------------
r.get('/playbook', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM email_playbook WHERE active = 1 ORDER BY approved_at DESC LIMIT 200'
  ).all();
  return ok(c, rows.results ?? []);
});

r.post('/playbook/:id/revert', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('UPDATE email_playbook SET active = 0 WHERE id = ?').bind(id).run();
  return ok(c, { id, active: false });
});

// ---------------------------------------------------------------------------
// SETTINGS (auto-learning master switch + thresholds)
// ---------------------------------------------------------------------------
r.get('/settings', async (c) => {
  const rows = await c.env.DB.prepare('SELECT key, value FROM email_settings').all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const row of rows.results ?? []) out[row.key] = row.value;
  return ok(c, out);
});

r.put('/settings', async (c) => {
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]); }
  const allowed = ['auto_learning', 'auto_learning_min_seen', 'auto_learning_min_confidence'];
  const t = now();
  const stmts = [];
  for (const k of allowed) {
    if (body[k] !== undefined) {
      stmts.push(
        c.env.DB.prepare(
          'INSERT INTO email_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        ).bind(k, String(body[k]), t)
      );
    }
  }
  if (stmts.length === 0) return fail(c, 422, [{ code: 'no_fields', message: 'No valid settings provided' }]);
  await c.env.DB.batch(stmts);
  return ok(c, { updated: stmts.length });
});

// ---------------------------------------------------------------------------
// SEED — idempotent registry 1/4 scenarios + demo queue/lessons for preview
// ---------------------------------------------------------------------------
r.post('/seed', async (c) => {
  const t = now();
  const scenarios: Array<[string, string, string, string, string, string, number, number, number]> = [
    // id, name, executor, inbox, persona, trigger, enabled, sent_clean, edited
    ['pechkin-s1-ozon-complaints', 'Ozon lost-order complaints', 'hermes', 'support@dasexperten.de',
      'Viktor Orlov (signs to women) / Olga Lebedeva (signs to men) · blame Ozon logistics · auto-refund on cancel · never ask for card',
      'keywords: где заказ / не пришёл / трек / ПВЗ … · newer_than:12h · skip marketplace@seller.ozon.ru · skip if support@/gmail already in thread', 1, 44, 6],
    ['pechkin-s2-ozon-returns', 'Auto-delete Ozon return notices', 'worker', 'marketplace@seller.ozon.ru',
      'no send — trash matching system threads only (subject filter, never whole sender)',
      'from:marketplace@seller.ozon.ru subject:(возврат OR "точка выдачи" OR заберите) · newer_than:12h', 1, 31, 0],
    ['pechkin-s3-zukonar-forward', 'Forward ЦУКОН invoices → Maria Kosareva', 'worker', 'eurasia@dasexperten.de',
      'forward only → kosarevam491@gmail.com · skip if already in participants[]',
      'from:zukonar@mail.ru · newer_than:12h', 1, 12, 1],
    ['pechkin-s4-inbox-triage', 'Inbox triage', 'hermes', 'eurasia@dasexperten.de',
      'classify + route, no auto-send · 5-inbox router (eurasia/emea/marketing/sales/support)',
      'in:anywhere newer_than:24h · exclude own dasexperten.de senders', 1, 18, 7],
  ];
  const stmts = scenarios.map(([id, name, executor, inbox, persona, trig, enabled, clean, edited]) =>
    c.env.DB.prepare(
      `INSERT INTO email_scenarios (id, name, executor, inbox, from_address, persona_rule, trigger_spec, enabled, sent_clean, edited, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'dasexperten@gmail.com', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, executor=excluded.executor, inbox=excluded.inbox,
         persona_rule=excluded.persona_rule, trigger_spec=excluded.trigger_spec, updated_at=excluded.updated_at`
    ).bind(id, name, executor, inbox, persona, trig, enabled, clean, edited, t, t)
  );
  await c.env.DB.batch(stmts);

  // Demo pending lessons (only if none exist yet) so the Learning tab shows live data.
  const haveLessons = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM email_lessons").first<{ n: number }>();
  if ((haveLessons?.n ?? 0) === 0) {
    const lessons: Array<[string, string, string, string, number]> = [
      ['pechkin-s1-ozon-complaints', 'Offer the promo code in the first reply — not after the fix.',
        '…после устранения проблемы вышлем вам промокод.',
        '…прикладываю промокод −25% прямо сейчас. Извинения за логистику Ozon.', 4],
      ['pechkin-s1-ozon-complaints', 'Open with the order number — no greeting, no self-justification.',
        'Здравствуйте! Прочитал ваше письмо, некрасиво с нашей стороны…',
        'Заказ 0312-… — уже разбираемся, отвечаю по сути.', 2],
      ['pechkin-s4-inbox-triage', 'Route distributor pricing asks to sales@, not eurasia@.',
        'routed to eurasia@', 'routed to sales@', 1],
    ];
    await c.env.DB.batch(lessons.map(([sc, prop, before, after, seen]) =>
      c.env.DB.prepare(
        "INSERT INTO email_lessons (id, scenario_id, proposed, diff_before, diff_after, seen_count, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
      ).bind(crypto.randomUUID(), sc, prop, before, after, seen, t)
    ));
  }

  const haveCanon = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM email_playbook").first<{ n: number }>();
  if ((haveCanon?.n ?? 0) === 0) {
    const canon: Array<[string, string]> = [
      ['pechkin-s1-ozon-complaints', 'Ozon underdelivery → blame Ozon logistics, auto-refund on cancel, never ask for card.'],
      ['global', 'Never mention German origin in the body.'],
      ['global', 'Cold first email is never signed by Aram.'],
      ['global', 'Cron sends always go from dasexperten@gmail.com (SPF).'],
    ];
    await c.env.DB.batch(canon.map(([sc, lesson]) =>
      c.env.DB.prepare(
        "INSERT INTO email_playbook (id, scenario_id, lesson, kind, active, approved_at, approved_by) VALUES (?, ?, ?, 'lesson', 1, ?, 'aram')"
      ).bind(crypto.randomUUID(), sc, lesson, t)
    ));
  }

  return ok(c, { seeded: scenarios.length });
});


r.post('/draft', async (c) => {
  let b: any = {};
  try { b = await c.req.json(); } catch { return fail(c, 400, [{ code: 'invalid_json', message: 'JSON body required' }]); }
  if (!b.body && !b.subject) return fail(c, 422, [{ code: 'no_input', message: 'subject or body required' }]);
  const inc = { sender: String(b.sender || ''), subject: String(b.subject || ''), body: String(b.body || '') };
  let res;
  try { res = await draftReply(c.env, inc); }
  catch (e) { return fail(c, 502, [{ code: 'engine_failed', message: String(e) }]); }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await c.env.DB.prepare(
      "INSERT INTO email_agent_tasks (id, scenario_id, source_email_id, subject, sender, status, draft_body, confidence, executor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'awaiting_ok', ?, ?, 'hermes', ?, ?)"
    ).bind(id, b.scenario_id || 'inbox-triage', b.source_email_id || null, inc.subject, inc.sender, res.draft, 0.8, now, now).run();
  } catch (e) { /* table may not FK-match scenario; still return draft */ }
  return ok(c, { task_id: id, brief: res.brief, draft: res.draft });
});

export default r;

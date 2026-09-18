// erp-inventory — inventory@dasexperten.com (Owner 2026-09-18): a warehouse without an API
// (Saransk) mails its stock list every one or two weeks. This worker reads the letter with
// DeepSeek on its own key (Owner: "deepseek secret ... put it inside that worker") and hands
// the letter plus the reading to the ERP, which archives it (§6.4) and turns the counts into
// an inventory session. If the reading fails here, the ERP reads it on its own key.
import PostalMime from 'postal-mime';
import { runLogged, type BaseEnv } from '../../_shared/run';
import { readInventoryLetter, bytesToB64, type InventoryLetter } from '../../../api/src/lib/inventory-mail';

interface Env extends BaseEnv {
  ERP: Fetcher;
  DEEPSEEK_API_KEY?: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    await runLogged(env, 'erp-inventory', 'mail', async () => {
      const parsed = await PostalMime.parse(raw);
      const letter: InventoryLetter = {
        from: parsed.from?.address || message.from,
        subject: parsed.subject || '(no subject)',
        messageId: parsed.messageId || '',
        text: parsed.text || undefined,
        html: parsed.html || undefined,
        attachments: (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? undefined,
          mimeType: a.mimeType,
          base64: bytesToB64(a.content as ArrayBuffer),
        })),
      };
      let reading = null;
      let readNote = 'read here';
      try {
        const r = await readInventoryLetter(env, letter);
        if (!('empty' in r)) reading = r;
        else readNote = 'nothing readable here';
      } catch (e) {
        readNote = `read here failed (${String(e).slice(0, 120)}) — ERP reads it`;
      }
      const res = await env.ERP.fetch('https://internal/internal/cron/erp-inventory', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.ERP_RUN_SECRET ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_b64: bytesToB64(raw), envelope_from: message.from, reading }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; note?: string; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(`ERP: HTTP ${res.status} ${body?.error ?? body?.note ?? ''} · ${readNote}`.trim());
      return { note: `${body.note} · ${readNote}` };
    });
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname === '/health') {
      return Response.json({ ok: true, worker: 'erp-inventory', mailbox: 'inventory@dasexperten.com', deepseek: Boolean(env.DEEPSEEK_API_KEY) });
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

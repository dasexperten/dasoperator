// inventory@ is a mail trigger. Archive, deduplication and the single mandatory
// Terra -> Sonnet -> DeepSeek Pro recognition chain run inside ERP before comparison.
import { runLogged, type BaseEnv } from '../../_shared/run';
import { bytesToB64 } from '../../../api/src/lib/inventory-mail';

interface Env extends BaseEnv {
  ERP: Fetcher;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    // Owner 2026-10-07: his Gmail is the monitor of every company box. Copy first;
    // a failed copy is logged and never stops the stock list reaching the ERP.
    try {
      await message.forward('dasexperten@gmail.com');
    } catch (e) {
      console.log(JSON.stringify({ scope: 'erp-inventory', stage: 'owner-copy', error: String(e).slice(0, 200) }));
    }
    await runLogged(env, 'erp-inventory', 'mail', async () => {
      const res = await env.ERP.fetch('https://internal/internal/cron/erp-inventory', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.ERP_RUN_SECRET ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_b64: bytesToB64(raw), envelope_from: message.from }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; note?: string; error?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(`ERP: HTTP ${res.status} ${body?.error ?? body?.note ?? ''}`.trim());
      return { note: body.note ?? 'ERP inventory mail processed' };
    });
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname === '/health') {
      return Response.json({ ok: true, worker: 'erp-inventory', mailbox: 'inventory@dasexperten.com', recognition: 'ERP: OpenAI Terra -> Sonnet -> DeepSeek Pro' });
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

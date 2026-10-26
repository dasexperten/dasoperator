import { ensureOperationLink, linkManualOperation } from "./operation-link";
import {
  callEndpoint,
  codeOf,
  downloadInvoice,
  isProviderSuccess,
  needsVerification,
  strictBaseUrl,
  type EasyInvoiceConfig,
  type ProviderResult,
} from "./easyinvoice";
import {
  normalizeOrder,
  manualIkey,
  orderXml,
  matchedInvoice,
  invoiceMatches,
  invoiceStage,
  seriesMatches,
  validTimestamp,
  validTransferDate,
  validTransferMoment,
  textField,
  vietnamDate,
  type ManualOrder,
} from "./manual-order";

export interface ManualEnv {
  DB: D1Database;
  DOCS: R2Bucket;
  ERP_RUN_SECRET?: string;
  EASYINVOICE_ENABLED?: string;
  EASYINVOICE_BASE_URL?: string;
  EASYINVOICE_USERNAME?: string;
  EASYINVOICE_PASSWORD?: string;
  EASYINVOICE_TAX_CODE?: string;
  EASYINVOICE_PATTERN?: string;
  EASYINVOICE_SERIAL?: string;
}
export interface ManualRow {
  id: string;
  source_order_id: string;
  ikey: string;
  state: string;
  normalized_order_json: string;
  transfer_at: string | null;
  transfer_evidence: string | null;
  transfer_recorded_by: string | null;
  provider_invoice_status: number | null;
  provider_phase: string | null;
  provider_message: string | null;
  verify_count: number;
  provider_pdf_r2_key: string | null;
  provider_xml_r2_key: string | null;
  request_r2_key: string;
  response_r2_key: string | null;
  [key: string]: any;
}
const now = () => Math.floor(Date.now() / 1000);
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const LEASE_SECONDS = 180; // Five sequential provider calls have a 20s timeout each; leave recovery margin.
function config(env: ManualEnv): EasyInvoiceConfig {
  if (
    !env.EASYINVOICE_USERNAME ||
    !env.EASYINVOICE_PASSWORD ||
    !env.EASYINVOICE_TAX_CODE ||
    !env.EASYINVOICE_PATTERN ||
    env.EASYINVOICE_SERIAL === undefined
  )
    throw new Error("provider_config_missing");
  return {
    baseUrl: strictBaseUrl(env.EASYINVOICE_BASE_URL || ""),
    username: env.EASYINVOICE_USERNAME,
    password: env.EASYINVOICE_PASSWORD,
    taxCode: env.EASYINVOICE_TAX_CODE,
    pattern: env.EASYINVOICE_PATTERN,
    serial: env.EASYINVOICE_SERIAL,
  };
}
async function read(env: ManualEnv, id: string): Promise<ManualRow | null> {
  return env.DB.prepare(
    "SELECT * FROM vn_einvoice_documents WHERE id=? AND workflow='manual'",
  )
    .bind(id)
    .first<ManualRow>();
}
async function update(
  env: ManualEnv,
  id: string,
  values: Record<string, unknown>,
) {
  const entries = Object.entries({ ...values, updated_at: now() });
  await env.DB.prepare(
    `UPDATE vn_einvoice_documents SET ${entries.map(([k]) => `${k}=?`).join(",")} WHERE id=?`,
  )
    .bind(...entries.map(([, v]) => v), id)
    .run();
}
export function publicManual(row: ManualRow) {
  let display_status = row.state;
  if (row.provider_invoice_status === 0)
    display_status =
      row.transfer_at ||
      ["release_requested", "release_payload_sent", "issue_sent"].includes(
        row.provider_phase ?? "",
      ) ||
      row.state === "submitting"
        ? "awaiting_issue"
        : "draft";
  if (row.state === "verify_pending") display_status = "verifying";
  if (row.state === "blocked_config") display_status = "issuance_disabled";
  if (row.state === "manual_review" || row.state === "failed_terminal")
    display_status = "needs_attention";
  if (row.state === "issued_archive_pending")
    display_status = "issued_pending_tax_or_archive";
  if (row.state === "issued") display_status = "tax_accepted_archived";
  return {
    ...row,
    order: JSON.parse(row.normalized_order_json),
    display_status,
  };
}
async function archive(
  env: ManualEnv,
  row: ManualRow,
  label: string,
  value: unknown,
): Promise<string> {
  const key = `vn-einvoice/${row.id}/${Date.now()}-${crypto.randomUUID()}-${label}.json`;
  await env.DOCS.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}
async function providerCall(
  env: ManualEnv,
  row: ManualRow,
  cfg: EasyInvoiceConfig,
  endpoint: string,
  body: Record<string, unknown>,
  phase: "preflight" | "submit" | "verify",
  label: string,
): Promise<ProviderResult> {
  const start = now();
  try {
    const result = await callEndpoint(cfg, endpoint, body);
    const key = await archive(env, row, label, result);
    await env.DB.prepare(
      `INSERT INTO vn_einvoice_attempts(document_id,phase,started_at,finished_at,http_status,provider_status,provider_error_code,outcome,response_r2_key) VALUES(?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        row.id,
        phase,
        start,
        now(),
        result.httpStatus,
        Number(result.body.Status) || null,
        codeOf(result.body) || null,
        label,
        key,
      )
      .run();
    await update(env, row.id, {
      response_r2_key: key,
      provider_status: Number(result.body.Status) || null,
      provider_error_code: codeOf(result.body) || null,
    });
    return result;
  } catch (error) {
    await env.DB.prepare(
      `INSERT INTO vn_einvoice_attempts(document_id,phase,started_at,finished_at,outcome,detail) VALUES(?,?,?,?,?,?)`,
    )
      .bind(
        row.id,
        phase,
        start,
        now(),
        "transport_uncertain",
        error instanceof Error
          ? error.message.slice(0, 300)
          : "provider_call_failed",
      )
      .run();
    throw error;
  }
}
async function getInvoice(
  env: ManualEnv,
  row: ManualRow,
  cfg: EasyInvoiceConfig,
) {
  const result = await providerCall(
    env,
    row,
    cfg,
    "api/publish/getInvoicesByIkeys",
    { Ikeys: [row.ikey] },
    "verify",
    "invoice-readback",
  );
  if (codeOf(result.body) === "128") return null;
  if (!isProviderSuccess(result.body))
    throw new Error(`provider_read_${codeOf(result.body) || "failed"}`);
  const inv = matchedInvoice(result.body, row.ikey);
  if (
    !inv &&
    Array.isArray((result.body.Data as any)?.Invoices) &&
    !(result.body.Data as any).Invoices.length
  )
    return null;
  if (!inv) throw new Error("provider_readback_ambiguous");
  return inv;
}
async function files(
  env: ManualEnv,
  row: ManualRow,
  cfg: EasyInvoiceConfig,
  draft: boolean,
) {
  let pdf = row.provider_pdf_r2_key,
    xml = row.provider_xml_r2_key;
  for (const option of (draft ? [0] : [0, -1]) as Array<0 | -1>) {
    // Refresh both artifacts after every tax-state transition; pending XML is not final XML.
    try {
      const file = await downloadInvoice(cfg, row.ikey, cfg.pattern, option);
      if (file.httpStatus < 200 || file.httpStatus >= 300) continue;
      const bytes = new Uint8Array(file.bytes);
      if (
        option === 0 &&
        new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
      )
        continue;
      if (option === -1) {
        const content = new TextDecoder().decode(bytes).trim();
        if (
          !content.startsWith("<") ||
          /<(?:!doctype\s+html|html|error|ErrorResponse)\b/i.test(content)
        )
          continue;
      }
      const key = `vn-einvoice/${row.id}/${draft ? "draft" : "issued"}-${Date.now()}.${option === 0 ? "pdf" : "xml"}`;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      const latest = await read(env, row.id);
      await env.DOCS.put(key, file.bytes, {
        httpMetadata: {
          contentType: option === 0 ? "application/pdf" : "application/xml",
        },
        customMetadata: {
          sha256,
          ikey: row.ikey,
          provider_readback: latest?.response_r2_key ?? "",
        },
      });
      if (option === 0) pdf = key;
      else xml = key;
    } catch {
      /* Readback/archival retries never call issue again. */
    }
  }
  await update(env, row.id, {
    provider_pdf_r2_key: pdf,
    provider_xml_r2_key: xml,
  });
  return { pdf, xml };
}
async function hold(env: ManualEnv, row: ManualRow, message: string) {
  await update(env, row.id, {
    state: "manual_review",
    provider_message: message,
    next_attempt_at: null,
  });
}
async function uncertain(env: ManualEnv, row: ManualRow, message: string) {
  await update(env, row.id, {
    state: "verify_pending",
    provider_message: message,
    next_attempt_at: now() + 300,
  });
}
async function miss(env: ManualEnv, row: ManualRow, message: string) {
  const count = row.verify_count + 1;
  await update(env, row.id, {
    verify_count: count,
    state: count >= 3 ? "manual_review" : "verify_pending",
    provider_message: message,
    next_attempt_at: count >= 3 ? null : now() + 300,
  });
}
async function saveInvoice(
  env: ManualEnv,
  row: ManualRow,
  inv: Record<string, any>,
) {
  await update(env, row.id, {
    provider_invoice_status: Number(inv.InvoiceStatus),
    invoice_no: inv.No == null ? null : String(inv.No),
    lookup_code: inv.LookupCode ?? null,
    provider_message: JSON.stringify({
      invoice_status: inv.InvoiceStatus,
      tax_status: inv.TCTCheckStatus,
      tax_error: inv.TCTErrorMessage ?? null,
      tax_code: inv.TaxAuthorityCode ?? null,
    }),
  });
}
async function submitDraft(
  env: ManualEnv,
  row: ManualRow,
  cfg: EasyInvoiceConfig,
  order: ManualOrder,
  at: string,
  phase: string,
) {
  const xml = orderXml(order, at, row.ikey);
  const sourceKey = `vn-einvoice/${row.id}/${Date.now()}-${phase}-source.xml`;
  await env.DOCS.put(sourceKey, xml, {
    httpMetadata: { contentType: "application/xml" },
  });
  await update(env, row.id, { state: "submitting", provider_phase: phase });
  const result = await providerCall(
    env,
    row,
    cfg,
    "api/publish/importInvoice",
    { XmlData: xml, Pattern: cfg.pattern, Serial: cfg.serial },
    "submit",
    phase,
  );
  if (!isProviderSuccess(result.body))
    throw new Error(`draft_${codeOf(result.body) || "rejected"}`);
  return getInvoice(env, row, cfg);
}
type ReleaseRequest = {
  requested_by: string;
  requested_at: string;
  invoice_date: string;
  date_source: "EasyInvoice.ArisingDate";
  provider_ikey: string;
  provider_readback_r2_key: string;
  source_request_r2_key: string;
};
function dateFromProvider(value: unknown): string {
  const match =
    typeof value === "string"
      ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim())
      : null;
  if (!match) throw new Error("provider_invoice_date_invalid");
  return validTransferDate(`${match[3]}-${match[2]}-${match[1]}`);
}
async function releaseIntent(
  env: ManualEnv,
  row: ManualRow,
  invoice: Record<string, any>,
  actor?: string,
): Promise<ReleaseRequest | null> {
  const object = await env.DOCS.get(row.request_r2_key);
  const source = object ? JSON.parse(await object.text()) : null;
  if (source?.release_request) {
    const saved = source.release_request as ReleaseRequest;
    if (
      saved.provider_ikey !== row.ikey ||
      saved.date_source !== "EasyInvoice.ArisingDate" ||
      !saved.requested_by ||
      !saved.requested_at
    )
      throw new Error("release_audit_invalid");
    validTransferDate(saved.invoice_date);
    return saved;
  }
  if (!actor) return null;
  if (!source) throw new Error("manual_order_source_missing");
  const latest = await read(env, row.id);
  const intent: ReleaseRequest = {
    requested_by: actor,
    requested_at: new Date().toISOString(),
    invoice_date: dateFromProvider(invoice.ArisingDate),
    date_source: "EasyInvoice.ArisingDate",
    provider_ikey: row.ikey,
    provider_readback_r2_key: latest?.response_r2_key ?? "",
    source_request_r2_key: row.request_r2_key,
  };
  const key = `vn-einvoice/${row.id}/${Date.now()}-${crypto.randomUUID()}-release-request.json`;
  await env.DOCS.put(
    key,
    JSON.stringify({ ...source, release_request: intent }),
    { httpMetadata: { contentType: "application/json" } },
  );
  await update(env, row.id, {
    request_r2_key: key,
    provider_phase: "release_requested",
    state: "submitting",
    next_attempt_at: now(),
  });
  await env.DB.prepare(
    "INSERT INTO vn_einvoice_attempts(document_id,phase,started_at,finished_at,outcome,detail) VALUES(?, 'preflight',?,?, 'explicit_release_requested',?)",
  )
    .bind(row.id, now(), now(), JSON.stringify(intent))
    .run();
  row.request_r2_key = key;
  row.provider_phase = "release_requested";
  row.state = "submitting";
  return intent;
}
export async function processManual(
  env: ManualEnv,
  id: string,
  releaseActor?: string,
): Promise<ManualRow | null> {
  const lease = crypto.randomUUID();
  const locked = await env.DB.prepare(
    "UPDATE vn_einvoice_documents SET processing_token=?,processing_until=? WHERE id=? AND workflow='manual' AND (processing_until IS NULL OR processing_until<?)",
  )
    .bind(lease, now() + LEASE_SECONDS, id, now())
    .run();
  if (!locked.meta.changes) return read(env, id);
  let row = await read(env, id);
  if (!row) return null;
  try {
    const cfg = config(env),
      order = normalizeOrder(JSON.parse(row.normalized_order_json));
    if (row.pattern !== cfg.pattern || row.serial !== cfg.serial) {
      await hold(env, row, "provider_series_config_changed");
      return read(env, id);
    }
    let inv = await getInvoice(env, row, cfg);
    if (!inv) {
      if (row.provider_phase?.endsWith("_sent")) {
        await miss(env, row, "provider_missing_after_uncertain_action");
        return read(env, id);
      }
      if (row.provider_phase !== "draft_create") {
        await hold(env, row, "expected_provider_draft_missing");
        return read(env, id);
      }
      inv = await submitDraft(
        env,
        row,
        cfg,
        order,
        order.captured_at,
        "draft_create_sent",
      );
      if (!inv) {
        await uncertain(env, row, "draft_not_yet_visible");
        return read(env, id);
      }
    } else if (row.provider_phase === "draft_create") {
      await hold(
        env,
        row,
        "existing_provider_invoice_requires_source_adoption",
      );
      return read(env, id);
    }
    if (!seriesMatches(inv, cfg.pattern, cfg.serial)) {
      await hold(env, row, "provider_series_mismatch");
      return read(env, id);
    }
    if (!invoiceMatches(order, inv, row.ikey)) {
      await hold(env, row, "provider_fiscal_facts_mismatch");
      return read(env, id);
    }
    await saveInvoice(env, row, inv);
    let stage = invoiceStage(inv);
    if (["cancelled", "corrected", "unknown", "tax_rejected"].includes(stage)) {
      await hold(env, row, `provider_${stage}`);
      return read(env, id);
    }
    if (row.issued_at && (stage === "draft" || stage === "signing")) {
      await hold(env, row, "provider_state_regressed_after_issue");
      return read(env, id);
    }
    if (stage === "signing") {
      await uncertain(env, row, "provider_signing");
      return read(env, id);
    }
    if (stage === "draft") {
      // An uncertain issue is reconciled, never resent just because status0 is
      // still visible while the provider's signing job may be running.
      if (row.provider_phase === "issue_sent") {
        await miss(env, row, "issue_result_not_yet_visible");
        return read(env, id);
      }
      const release = await releaseIntent(env, row, inv, releaseActor);
      if (!row.transfer_at && !release) {
        await files(env, row, cfg, true);
        await update(env, id, {
          state: "received",
          provider_phase: "draft",
          next_attempt_at: null,
          verify_count: 0,
        });
        return read(env, id);
      }
      const invoiceDate = release?.invoice_date ?? row.transfer_at!;
      if (!release) {
        validTransferMoment(invoiceDate);
        textField(row.transfer_evidence, "transfer_evidence_ref", 2000);
      }
      if (env.EASYINVOICE_ENABLED !== "1") {
        await update(env, id, {
          state: "blocked_config",
          provider_message: "provider_disabled",
          next_attempt_at: null,
        });
        return read(env, id);
      }
      // Always restore the canonical lines before release: header readback does not expose products.
      {
        inv = await submitDraft(
          env,
          row,
          cfg,
          order,
          invoiceDate,
          release ? "release_payload_sent" : "draft_date_update_sent",
        );
        if (
          !inv ||
          !invoiceMatches(order, inv, row.ikey) ||
          !seriesMatches(inv, cfg.pattern, cfg.serial) ||
          String(inv.ArisingDate).slice(0, 10) !== vietnamDate(invoiceDate)
        ) {
          await hold(env, row, "invoice_date_readback_mismatch");
          return read(env, id);
        }
        if (invoiceStage(inv) !== "draft") {
          await uncertain(
            env,
            row,
            "provider_state_changed_during_date_update",
          );
          return read(env, id);
        }
      }
      await update(env, id, {
        state: "submitting",
        provider_phase: "issue_sent",
      });
      const issued = await providerCall(
        env,
        row,
        cfg,
        "api/publish/issueInvoices",
        { Ikeys: [row.ikey], Pattern: cfg.pattern, Serial: cfg.serial },
        "submit",
        "issue-existing-draft",
      );
      if (!isProviderSuccess(issued.body)) {
        if (needsVerification(issued.body))
          await uncertain(env, row, `issue_${codeOf(issued.body)}`);
        else await hold(env, row, `issue_${codeOf(issued.body) || "rejected"}`);
        return read(env, id);
      }
      inv = await getInvoice(env, row, cfg);
      if (
        !inv ||
        !invoiceMatches(order, inv, row.ikey) ||
        !seriesMatches(inv, cfg.pattern, cfg.serial)
      ) {
        await uncertain(env, row, "issue_readback_pending");
        return read(env, id);
      }
      await saveInvoice(env, row, inv);
      stage = invoiceStage(inv);
      if (stage === "draft" || stage === "signing") {
        await uncertain(env, row, "issue_readback_pending");
        return read(env, id);
      }
    }
    if (stage === "issued_pending_tax" || stage === "tax_accepted") {
      const archived = await files(
        env,
        { ...row, provider_pdf_r2_key: null, provider_xml_r2_key: null },
        cfg,
        false,
      );
      const complete = stage === "tax_accepted" && archived.pdf && archived.xml;
      await update(env, id, {
        state: complete ? "issued" : "issued_archive_pending",
        provider_phase: stage,
        issued_at: row.issued_at ?? now(),
        completed_at: complete ? now() : null,
        next_attempt_at: complete ? null : now() + 300,
        verify_count: 0,
      });
    } else await hold(env, row, `provider_${stage}`);
  } catch (error) {
    await uncertain(
      env,
      row,
      error instanceof Error
        ? error.message.slice(0, 300)
        : "manual_processing_failed",
    );
  } finally {
    await env.DB.prepare(
      "UPDATE vn_einvoice_documents SET processing_token=NULL,processing_until=NULL WHERE id=? AND processing_token=?",
    )
      .bind(id, lease)
      .run();
    const linked = await read(env, id);
    if (linked)
      await ensureOperationLink(
        env,
        linked,
        releaseActor ?? "system:vn-einvoice",
      );
  }
  return read(env, id);
}
async function validateAdoption(
  env: ManualEnv,
  extractionId: string,
  order: ManualOrder,
) {
  const ext = await env.DB.prepare(
    "SELECT raw_extract_json FROM document_extractions WHERE id=? AND deleted_at IS NULL",
  )
    .bind(extractionId)
    .first<{ raw_extract_json: string }>();
  if (!ext) throw new Error("adoption_source_missing");
  const src = JSON.parse(ext.raw_extract_json);
  if (
    src.marketplace_order_id !== order.source_order_id ||
    String(src.marketplace ?? "").trim().toLowerCase().replace(/^tiktok shop$/, "tiktok") !== order.channel ||
    !src.provider_draft?.Ikey ||
    src.payable_gross_vnd !== order.total_gross ||
    src.billing?.tax_code !== (order.buyer.tax_code ?? "") ||
    src.billing?.name !== order.buyer.name ||
    src.billing?.address !== order.buyer.address
  )
    throw new Error("adoption_source_mismatch");
  const a = src.items
    .map((x: any) => [x.sku, x.qty, x.line_amount, x.vat_rate_pct].join("|"))
    .sort();
  const b = order.items
    .map((x) => [x.sku, x.quantity, x.gross_amount, x.vat_rate].join("|"))
    .sort();
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error("adoption_items_mismatch");
  return textField(src.provider_draft.Ikey, "provider_ikey", 120);
}
export async function manualRoutes(
  request: Request,
  env: ManualEnv,
): Promise<Response> {
  if (
    !env.ERP_RUN_SECRET ||
    request.headers.get("authorization") !== `Bearer ${env.ERP_RUN_SECRET}`
  )
    return json({ ok: false, error: "unauthorized" }, 401);
  const url = new URL(request.url),
    actor = request.headers.get("X-Actor-Id");
  if (!actor) return json({ ok: false, error: "actor_required" }, 401);
  try {
    if (request.method === "POST" && url.pathname === "/manual/orders") {
      const body = (await request.json()) as any,
        order = normalizeOrder(body);
      let ikey = manualIkey(order);
      const existing = await env.DB.prepare(
        "SELECT * FROM vn_einvoice_documents WHERE workflow='manual' AND source_order_id=? AND json_extract(normalized_order_json,'$.channel')=? LIMIT 1",
      )
        .bind(order.source_order_id, order.channel)
        .first<ManualRow>();
      if (existing) {
        if (
          existing.workflow !== "manual" ||
          existing.normalized_order_json !== JSON.stringify(order)
        )
          return json({ ok: false, error: "existing_order_differs" }, 409);
        const operation_id = await ensureOperationLink(env, existing, actor);
        return json({
          ok: true,
          idempotent: true,
          document: publicManual({
            ...existing,
            operation_id: operation_id ?? existing.operation_id,
          }),
        });
      }
      if (body.adopt_extraction_id)
        ikey = await validateAdoption(
          env,
          textField(body.adopt_extraction_id, "adopt_extraction_id", 120),
          order,
        );
      const id = crypto.randomUUID(),
        requestKey = `vn-einvoice/${id}/manual-order.json`;
      await env.DOCS.put(
        requestKey,
        JSON.stringify({
          order,
          recorded_by: actor,
          recorded_at: new Date().toISOString(),
          adopt_extraction_id: body.adopt_extraction_id ?? null,
        }),
        { httpMetadata: { contentType: "application/json" } },
      );
      try {
        await env.DB.prepare(
          `INSERT INTO vn_einvoice_documents(id,source,source_event_id,source_order_id,action,ikey,pattern,serial,state,request_r2_key,created_at,updated_at,workflow,normalized_order_json,provider_phase) VALUES(?,?,?,?, 'issue',?,?,?,'received',?,?,?,'manual',?,?)`,
        )
          .bind(
            id,
            `manual_${order.channel}`,
            `manual:${order.channel}:${order.source_order_id}`,
            order.source_order_id,
            ikey,
            env.EASYINVOICE_PATTERN || null,
            env.EASYINVOICE_SERIAL ?? null,
            requestKey,
            now(),
            now(),
            JSON.stringify(order),
            body.adopt_extraction_id ? "adopt" : "draft_create",
          )
          .run();
      } catch (e) {
        const found = await env.DB.prepare(
          "SELECT * FROM vn_einvoice_documents WHERE ikey=?",
        )
          .bind(ikey)
          .first<ManualRow>();
        if (found && found.normalized_order_json === JSON.stringify(order)) {
          const operation_id = await ensureOperationLink(env, found, actor);
          return json({
            ok: true,
            idempotent: true,
            document: publicManual({
              ...found,
              operation_id: operation_id ?? found.operation_id,
            }),
          });
        }
        throw e;
      }
      const saved = await read(env, id);
      if (saved) await ensureOperationLink(env, saved, actor);
      const row = await processManual(env, id);
      return json({ ok: true, document: row ? publicManual(row) : null }, 202);
    }
    const match =
      /^\/manual\/orders\/([^/]+)\/(transfer|reconcile|issue|operation)$/.exec(
        url.pathname,
      );
    if (request.method === "POST" && match) {
      const row = await read(env, decodeURIComponent(match[1]!));
      if (!row) return json({ ok: false, error: "not_found" }, 404);
      if (match[2] === "operation") {
        const operation_id = await linkManualOperation(env, row, actor);
        return json({
          ok: true,
          operation_id,
          document: publicManual({ ...row, operation_id }),
        });
      }
      if (match[2] === "transfer") {
        const body = (await request.json()) as any;
        if (
          body.actual_transfer_date !== undefined &&
          body.actual_transfer_at !== undefined
        )
          return json({ ok: false, error: "transfer_date_ambiguous" }, 422);
        const at =
          body.actual_transfer_date !== undefined
            ? validTransferDate(body.actual_transfer_date)
            : validTimestamp(body.actual_transfer_at, "actual_transfer_at");
        const evidence = textField(body.evidence_ref, "evidence_ref", 2000);
        if (
          row.transfer_at &&
          (row.transfer_at !== at || row.transfer_evidence !== evidence)
        )
          return json({ ok: false, error: "transfer_already_recorded" }, 409);
        if (!row.transfer_at) {
          if (row.provider_invoice_status !== 0 || row.state !== "received")
            return json({ ok: false, error: "verified_draft_required" }, 409);
          await env.DB.prepare(
            "UPDATE vn_einvoice_documents SET transfer_at=?,transfer_evidence=?,transfer_recorded_by=?,transfer_recorded_at=?,updated_at=?,next_attempt_at=? WHERE id=? AND transfer_at IS NULL AND state='received' AND provider_invoice_status=0",
          )
            .bind(at, evidence, actor, now(), now(), now(), row.id)
            .run();
          const reread = await read(env, row.id);
          if (
            reread?.transfer_at !== at ||
            reread?.transfer_evidence !== evidence
          )
            return json({ ok: false, error: "transfer_conflict" }, 409);
        }
      }
      // The issue route intentionally ignores all caller-supplied fiscal fields.
      const processed = await processManual(
        env,
        row.id,
        match[2] === "issue" ? actor : undefined,
      );
      return json({
        ok: true,
        document: processed ? publicManual(processed) : null,
      });
    }
    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "invalid_request",
      },
      422,
    );
  }
}
export async function runManual(env: ManualEnv): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM vn_einvoice_documents WHERE workflow='manual' AND state IN ('received','blocked_config','verify_pending','issued_archive_pending','submitting') AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (provider_invoice_status IS NULL OR transfer_at IS NOT NULL OR state IN ('verify_pending','issued_archive_pending','submitting') OR provider_pdf_r2_key IS NULL OR provider_phase='release_requested') ORDER BY created_at LIMIT 20`,
  )
    .bind(now())
    .all<{ id: string }>();
  for (const row of rows.results ?? []) await processManual(env, row.id);
  return rows.results?.length ?? 0;
}

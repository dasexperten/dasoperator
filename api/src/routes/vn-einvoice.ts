import { linkManualOperation } from "../../../workers/erp-vn-einvoice/src/operation-link";
import { Hono } from "hono";
import type { Env } from "../types";
import { validateSession } from "../lib/auth";
import { ok, fail } from "../lib/responses";
import {
  publicManual,
  type ManualRow,
} from "../../../workers/erp-vn-einvoice/src/manual-workflow";

import {
  fiscalLines,
  fiscalTotals,
  matchedInvoice,
  seriesMatches,
  type ManualOrder,
} from "../../../workers/erp-vn-einvoice/src/manual-order";

import { isProviderSuccess } from "../../../workers/erp-vn-einvoice/src/easyinvoice";

async function withOrderFacts(env: Env, row: ManualRow) {
  const {
    source_snapshot_json,
    source_document_json,
    provider_checked_at,
    ...record
  } = row;
  let sourceDocument: {
    id: string;
    status: string;
    reviewed_at: number | null;
    target_id: string | null;
  } | null = null;
  try {
    const parsed = JSON.parse(source_document_json || "null");
    if (parsed?.id && parsed?.status) sourceDocument = parsed;
  } catch {
    /* Missing source metadata stays unknown. */
  }
  let providerCheck: {
    available: boolean;
    invoice_status: number | null;
    invoice_no: string | null;
    invoice_date: string | null;
    tax_status_raw: string | null;
    tax_error: string | null;
    tax_authority_code: string | null;
    checked_at: number | null;
  } = {
    available: false,
    invoice_status: null,
    invoice_no: null,
    invoice_date: null,
    tax_status_raw: null,
    tax_error: null,
    tax_authority_code: null,
    checked_at: null,
  };
  try {
    const object = row.response_r2_key
      ? await env.DOCS.get(row.response_r2_key)
      : null;
    if (object) {
      const receipt = JSON.parse(await object.text());
      const body = receipt.body;
      const invoice =
        body && isProviderSuccess(body) ? matchedInvoice(body, row.ikey) : null;
      if (invoice && seriesMatches(invoice, row.pattern, row.serial)) {
        const status = invoice.InvoiceStatus;
        const validStatus =
          typeof status === "number" ||
          (typeof status === "string" && /^-?\d+$/.test(status.trim()));
        providerCheck = {
          available: true,
          invoice_status: validStatus ? Number(status) : null,
          invoice_no: invoice.No == null ? null : String(invoice.No),
          invoice_date:
            typeof invoice.ArisingDate === "string"
              ? invoice.ArisingDate
              : null,
          tax_status_raw:
            invoice.TCTCheckStatus == null
              ? null
              : String(invoice.TCTCheckStatus),
          tax_error: invoice.TCTErrorMessage ?? null,
          tax_authority_code: invoice.TaxAuthorityCode ?? null,
          checked_at:
            typeof provider_checked_at === "number"
              ? provider_checked_at
              : null,
        };
      }
    }
  } catch {
    /* A missing or overwritten receipt never inherits a claimed provider outcome. */
  }
  let source: Record<string, any> = {};
  try {
    const parsed = JSON.parse(source_snapshot_json || "{}");
    source =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
  } catch {
    /* Old records may have no source metadata. */
  }
  const document = publicManual(record as ManualRow);
  const order = document.order as ManualOrder;
  return {
    ...document,
    provider_check: providerCheck,
    accounting_document: sourceDocument,
    fiscal_lines: fiscalLines(order),
    fiscal_totals: fiscalTotals(order),
    source_facts: {
      order_created_at: source.order_created_at ?? null,
      draft_date: source.provider_draft?.ArisingDate ?? null,
      carrier: source.carrier ?? null,
      tracking_number: source.tracking_number ?? null,
    },
  };
}

const route = new Hono<{ Bindings: Env; Variables: { actorId: string } }>();
route.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (!user)
    return fail(c, 401, [{ code: "unauthorized", message: "Войдите в ERP" }]);
  const access =
    user.role === "admin"
      ? "full"
      : (user.permissions["/operations"] ?? "none");
  if (
    access === "none" ||
    (c.req.method !== "GET" && !["full", "rw"].includes(access))
  ) {
    return fail(c, 403, [
      { code: "forbidden", message: "Нужен доступ к операциям" },
    ]);
  }
  c.set("actorId", user.id);
  return next();
});
const manualQuery = `SELECT v.*,
       (SELECT d.raw_extract_json FROM document_extractions d
         WHERE d.deleted_at IS NULL AND json_valid(d.raw_extract_json)
           AND json_extract(d.raw_extract_json,'$.provider_draft.Ikey')=v.ikey
         ORDER BY d.created_at DESC LIMIT 1) AS source_snapshot_json,
       (SELECT json_object('id',d.id,'status',d.status,'reviewed_at',d.reviewed_at,'target_id',d.target_id)
          FROM document_extractions d WHERE d.deleted_at IS NULL AND json_valid(d.raw_extract_json)
            AND json_extract(d.raw_extract_json,'$.provider_draft.Ikey')=v.ikey
          ORDER BY d.created_at DESC LIMIT 1) AS source_document_json,
       (SELECT a.finished_at FROM vn_einvoice_attempts a
          WHERE a.document_id=v.id AND a.response_r2_key=v.response_r2_key
            AND a.phase='verify' AND a.outcome='invoice-readback'
            AND (a.provider_status=2 OR a.provider_error_code='0')
          ORDER BY a.id DESC LIMIT 1) AS provider_checked_at
       FROM vn_einvoice_documents v WHERE v.workflow='manual'
`;
async function getDocument(env: Env, id: string) {
  return env.DB.prepare(manualQuery + " AND v.id=?")
    .bind(id)
    .first<ManualRow>();
}
route.get("/:id", async (c) => {
  const row = await getDocument(c.env, c.req.param("id"));
  if (!row)
    return fail(c, 404, [{ code: "not_found", message: "Инвойс не найден" }]);
  return ok(c, { document: await withOrderFacts(c.env, row) });
});
route.post("/:id/operation", async (c) => {
  const row = await getDocument(c.env, c.req.param("id"));
  if (!row)
    return fail(c, 404, [{ code: "not_found", message: "Инвойс не найден" }]);
  try {
    const operation_id = await linkManualOperation(
      c.env,
      row,
      c.get("actorId"),
    );
    return ok(c, {
      operation_id,
      document: await withOrderFacts(c.env, { ...row, operation_id }),
    });
  } catch (e) {
    return fail(c, 409, [
      {
        code: "operation_link_failed",
        message: e instanceof Error ? e.message : "Operation link failed",
      },
    ]);
  }
});
route.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    manualQuery + " ORDER BY v.created_at DESC LIMIT 100",
  ).all<ManualRow>();
  const candidates = await c.env.DB.prepare(
    `SELECT d.id,d.filename FROM document_extractions d
    WHERE d.deleted_at IS NULL AND json_extract(d.raw_extract_json,'$.provider_draft.Ikey') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM vn_einvoice_documents v WHERE v.ikey=json_extract(d.raw_extract_json,'$.provider_draft.Ikey'))
    ORDER BY d.created_at DESC LIMIT 20`,
  ).all();
  return ok(c, {
    documents: await Promise.all(
      (rows.results ?? []).map((row) => withOrderFacts(c.env, row)),
    ),
    saved_drafts: candidates.results ?? [],
  });
});
function xmlValue(xml: string, key: string): string | undefined {
  const value = new RegExp(`<${key}>([\\s\\S]*?)</${key}>`).exec(xml)?.[1];
  return value
    ?.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
route.get("/source/:id", async (c) => {
  const ext = await c.env.DB.prepare(
    "SELECT raw_extract_json,created_at FROM document_extractions WHERE id=? AND deleted_at IS NULL",
  )
    .bind(c.req.param("id"))
    .first<{ raw_extract_json: string; created_at: number }>();
  if (!ext)
    return fail(c, 404, [
      { code: "not_found", message: "Сохранённый черновик не найден" },
    ]);
  const source = JSON.parse(ext.raw_extract_json);
  if (!source.provider_draft?.Ikey || !source.marketplace_order_id)
    return fail(c, 422, [
      {
        code: "source_invalid",
        message: "Документ не является подготовленным черновиком заказа",
      },
    ]);
  const sourceKey = source.artifacts?.submitted_source_xml?.r2_key;
  const object = sourceKey ? await c.env.DOCS.get(sourceKey) : null;
  const xml = object ? await object.text() : "";
  const products = [...xml.matchAll(/<Product>([\s\S]*?)<\/Product>/g)].map(
    (m) => m[1]!,
  );
  const order = {
    source_order_id: source.marketplace_order_id,
    channel: String(source.marketplace ?? "manual").toLowerCase(),
    swifthub_order_id: source.swifthub_order_uuid,
    source_evidence_ref: `Order ${source.marketplace_order_id}; ERP source ${c.req.param("id")}`,
    captured_at: new Date(ext.created_at * 1000).toISOString(),
    currency: "VND",
    buyer: {
      kind: source.billing.tax_code ? "business" : "consumer",
      name: source.billing.name,
      address: source.billing.address,
      tax_code: source.billing.tax_code,
    },
    payment_method: xmlValue(xml, "PaymentMethod") ?? source.payment_method,
    items: source.items.map((line: any) => {
      const product =
        products.find((p) => xmlValue(p, "Code") === line.sku) ?? "";
      return {
        sku: line.sku,
        name: xmlValue(product, "ProdName") ?? line.description,
        unit: xmlValue(product, "ProdUnit") ?? "Tuýp",
        quantity: line.qty,
        gross_amount: line.line_amount,
        vat_rate: line.vat_rate_pct,
        vat_evidence_ref: (source.vat_evidence ?? []).join("\n"),
      };
    }),
    shipping_gross: source.shipping_original_vnd,
    shipping_discount: Math.abs(source.shipping_discount_vnd),
    total_gross: source.payable_gross_vnd,
    adopt_extraction_id: c.req.param("id"),
  };
  return ok(c, { order });
});
async function proxy(c: any, path: string) {
  if (!c.env.VN_EINVOICE || !c.env.ERP_RUN_SECRET)
    return fail(c, 503, [
      {
        code: "not_configured",
        message: "Подключение EasyInvoice не настроено",
      },
    ]);
  const body = await c.req.text();
  const result = await c.env.VN_EINVOICE.fetch(
    new Request(`https://vn-einvoice/manual/orders${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.ERP_RUN_SECRET}`,
        "X-Actor-Id": c.get("actorId"),
      },
      body,
    }),
  );
  const value = (await result.json()) as any;
  if (!value.ok)
    return fail(c, result.status, [
      {
        code: value.error ?? "invoice_error",
        message: value.error ?? "Invoice service failed",
      },
    ]);
  if (value.document?.id) {
    try {
      const row = await getDocument(c.env, value.document.id);
      if (row) {
        const operation_id = await linkManualOperation(
          c.env,
          row,
          c.get("actorId"),
        );
        await c.env.DB.prepare(
          "UPDATE vn_einvoice_documents SET operation_sync_error=NULL WHERE id=?",
        )
          .bind(row.id)
          .run();
        value.document = await withOrderFacts(c.env, {
          ...row,
          operation_id,
          operation_sync_error: null,
        });
      }
    } catch (error) {
      value.operation_sync_error =
        error instanceof Error ? error.message : "operation_sync_failed";
      await c.env.DB.prepare(
        "UPDATE vn_einvoice_documents SET operation_sync_error=? WHERE id=?",
      )
        .bind(value.operation_sync_error, value.document.id)
        .run()
        .catch(() => {});
    }
  }
  return ok(c, value);
}
route.post("/", (c) => proxy(c, ""));
route.post("/:id/transfer", (c) =>
  proxy(c, `/${encodeURIComponent(c.req.param("id"))}/transfer`),
);
route.post("/:id/issue", (c) =>
  proxy(c, `/${encodeURIComponent(c.req.param("id"))}/issue`),
);
route.post("/:id/reconcile", (c) =>
  proxy(c, `/${encodeURIComponent(c.req.param("id"))}/reconcile`),
);
route.get("/:id/file/:kind", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT provider_pdf_r2_key,provider_xml_r2_key FROM vn_einvoice_documents WHERE id=? AND workflow='manual'",
  )
    .bind(c.req.param("id"))
    .first<{
      provider_pdf_r2_key: string | null;
      provider_xml_r2_key: string | null;
    }>();
  const kind = c.req.param("kind");
  const key =
    kind === "pdf"
      ? row?.provider_pdf_r2_key
      : kind === "xml"
        ? row?.provider_xml_r2_key
        : null;
  if (!key)
    return fail(c, 404, [
      { code: "not_archived", message: "Файл ещё не добавлен в архив" },
    ]);
  const object = await c.env.DOCS.get(key);
  if (!object)
    return fail(c, 404, [
      { code: "file_missing", message: "Файл архива не найден" },
    ]);
  return new Response(object.body, {
    headers: {
      "Content-Type": kind === "pdf" ? "application/pdf" : "application/xml",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="invoice-${c.req.param("id")}.${kind}"`,
    },
  });
});
export default route;

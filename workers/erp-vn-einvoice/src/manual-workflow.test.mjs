import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "vn-manual-"));
for (const name of ["manual-order", "manual-workflow"]) {
  const out = await build({
    entryPoints: [new URL(`./${name}.ts`, import.meta.url).pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  writeFileSync(join(dir, `${name}.mjs`), out.outputFiles[0].text);
}
const model = await import(join(dir, "manual-order.mjs"));
const { processManual, manualRoutes, runManual } = await import(
  join(dir, "manual-workflow.mjs")
);
const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
const order = {
  source_order_id: "530124445322445",
  channel: "lazada",
  source_evidence_ref: "verified source",
  captured_at: "2026-10-20T12:00:00Z",
  currency: "VND",
  buyer: {
    kind: "business",
    name: "Buyer Ltd",
    address: "Address",
    tax_code: "3600661374",
  },
  payment_method: "Unpaid",
  items: [
    {
      sku: "DE210",
      name: "INNOWEISS",
      unit: "Tube",
      quantity: 1,
      gross_amount: 199000,
      vat_rate: 8,
      vat_evidence_ref: "customs and trade regulation",
    },
    {
      sku: "DE203",
      name: "GINGER",
      unit: "Tube",
      quantity: 1,
      gross_amount: 99000,
      vat_rate: 8,
      vat_evidence_ref: "customs and trade regulation",
    },
  ],
  shipping_gross: 32800,
  shipping_discount: 32800,
  total_gross: 298000,
};
const normalized = model.normalizeOrder(order);
const draft = {
  Ikey: model.manualIkey(normalized),
  Pattern: "1C26MAA",
  Serial: "",
  InvoiceStatus: 0,
  No: "0",
  Total: 275926,
  TaxAmount: 22074,
  Amount: 298000,
  CustomerName: "Buyer Ltd",
  CustomerAddress: "Address",
  CustomerTaxCode: "3600661374",
  ArisingDate: "20/10/2026",
  TCTCheckStatus: "Chưa gửi thuế",
};
function fixture({
  phase = "adopt",
  transfer = null,
  enabled = false,
  invoice = draft,
} = {}) {
  const sql = new DatabaseSync(":memory:");
  for (const n of ["0095_vn_einvoice.sql", "0142_vn_einvoice_manual.sql"])
    sql.exec(
      readFileSync(
        new URL(`../../../db/migrations/${n}`, import.meta.url),
        "utf8",
      ),
    );
  sql.exec(
    "CREATE TABLE document_extractions(id TEXT,raw_extract_json TEXT,deleted_at INTEGER)",
  );
  sql
    .prepare(
      "INSERT INTO vn_einvoice_documents(id,source,source_event_id,source_order_id,action,ikey,pattern,serial,state,request_r2_key,created_at,updated_at,workflow,normalized_order_json,provider_phase,transfer_at,transfer_evidence) VALUES('doc','manual_lazada','event',?,'issue',?,'1C26MAA','','received','source',1,1,'manual',?,?,?,?)",
    )
    .run(
      order.source_order_id,
      draft.Ikey,
      JSON.stringify(normalized),
      phase,
      transfer,
      transfer ? "customer acceptance" : null,
    );
  const objects = new Map([
      [
        "source",
        JSON.stringify({ order: normalized, recorded_by: "source-operator" }),
      ],
    ]),
    calls = [];
  let provider = invoice ? { ...invoice } : null;
  const DB = {
    prepare(query) {
      let args = [];
      return {
        bind(...x) {
          args = x;
          return this;
        },
        async first() {
          return sql.prepare(query).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
        async run() {
          const r = sql.prepare(query).run(...args);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
      };
    },
  };
  const env = {
    DB,
    DOCS: {
      async put(k, v) {
        objects.set(k, v);
      },
      async get(k) {
        return objects.has(k) ? { text: async () => objects.get(k) } : null;
      },
    },
    ERP_RUN_SECRET: "test",
    EASYINVOICE_ENABLED: enabled ? "1" : "0",
    EASYINVOICE_BASE_URL: "https://provider.test",
    EASYINVOICE_USERNAME: "test",
    EASYINVOICE_PASSWORD: "test",
    EASYINVOICE_TAX_CODE: "test",
    EASYINVOICE_PATTERN: "1C26MAA",
    EASYINVOICE_SERIAL: "",
  };
  let handler = null;
  globalThis.fetch = async (url, init) => {
    const endpoint = new URL(url).pathname.split("/").at(-1),
      body = JSON.parse(init.body);
    calls.push({ endpoint, body });
    if (handler) {
      const r = await handler(endpoint, body);
      if (r) return r;
    }
    if (endpoint === "getInvoicesByIkeys")
      return Response.json({
        Status: 2,
        Data: { Invoices: provider ? [provider] : [] },
      });
    if (endpoint === "importInvoice") {
      provider = {
        ...draft,
        ArisingDate: /<ArisingDate>(.*?)</.exec(body.XmlData)[1],
      };
      return Response.json({ Status: 2 });
    }
    if (endpoint === "issueInvoices") {
      provider = {
        ...provider,
        InvoiceStatus: 1,
        No: "12",
        TCTCheckStatus: 1,
        TaxAuthorityCode: "AUTH",
      };
      return Response.json({ Status: 2 });
    }
    if (endpoint === "getInvoicePdf")
      return new Response(
        body.Option === 0
          ? "%PDF-1.4 test"
          : "<Invoice><No>12</No><TaxAuthorityCode>AUTH</TaxAuthorityCode></Invoice>",
      );
    throw new Error("unexpected " + endpoint);
  };
  return {
    sql,
    env,
    objects,
    calls,
    row: () =>
      sql.prepare("SELECT * FROM vn_einvoice_documents WHERE id='doc'").get(),
    setInvoice: (v) => (provider = v),
    setHandler: (fn) => (handler = fn),
  };
}
const response = (env, path, body, headers = {}) =>
  manualRoutes(
    new Request("https://worker/manual/orders" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "X-Actor-Id": "session-user",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    env,
  );
test("integer VND arithmetic reproduces actual order and preserves shipping components", () => {
  assert.deepEqual(model.fiscalTotals(normalized), {
    net: 275926,
    vat: 22074,
    gross: 298000,
  });
  assert.deepEqual(
    model.fiscalLines(normalized).map((x) => [x.net_amount, x.vat_amount]),
    [
      [184259, 14741],
      [91667, 7333],
    ],
  );
  assert.equal(normalized.shipping_gross, 32800);
  assert.equal(normalized.shipping_discount, 32800);
  assert.equal(model.vndWords(298000), "Hai trăm chín mươi tám nghìn đồng");
});
test("XML escapes actual labels and uses Vietnam transfer calendar date", () => {
  const copy = structuredClone(normalized);
  copy.buyer.name = "A&B <Buyer>";
  assert.match(
    model.orderXml(copy, "2026-10-20T18:00:00Z"),
    /A&amp;B &lt;Buyer&gt;/,
  );
  assert.match(
    model.orderXml(copy, "2026-10-20T18:00:00Z"),
    /<ArisingDate>21\/10\/2026/,
  );
});
test("no implicit VAT0, totals or shipping allocations", () => {
  for (const change of [
    (x) => delete x.items[0].vat_rate,
    (x) => x.total_gross++,
    (x) => (x.shipping_discount = 0),
    (x) => (x.items[1].vat_rate = 10),
  ]) {
    const x = structuredClone(order);
    change(x);
    assert.throws(() => model.normalizeOrder(x));
  }
});
test("provider status is separate from envelope and null is never draft", () => {
  for (const value of [null, undefined, "", false, " ", []])
    assert.equal(
      model.invoiceStage({ ...draft, InvoiceStatus: value }),
      "unknown",
    );
  assert.equal(model.invoiceStage(draft), "draft");
  assert.equal(model.invoiceStage({ ...draft, InvoiceStatus: -1 }), "signing");
  for (const status of [1, "1", "Hợp lệ"])
    assert.equal(
      model.invoiceStage({
        ...draft,
        InvoiceStatus: 1,
        No: 12,
        TCTCheckStatus: status,
        TaxAuthorityCode: "AUTH",
      }),
      "tax_accepted",
    );
  assert.equal(
    model.invoiceStage({
      ...draft,
      InvoiceStatus: 1,
      No: 12,
      TCTCheckStatus: -2,
    }),
    "tax_rejected",
  );
});
test("adopts existing draft while disabled; no import, issue or fake transfer", async () => {
  const f = fixture();
  await processManual(f.env, "doc");
  assert.equal(f.row().provider_invoice_status, 0);
  assert.equal(f.row().state, "received");
  assert.equal(f.row().transfer_at, null);
  assert.deepEqual(
    f.calls.map((x) => x.endpoint),
    ["getInvoicesByIkeys", "getInvoicePdf"],
  );
  assert.ok(f.row().provider_pdf_r2_key);
});
test("draft creation uses stable key and remains unsigned", async () => {
  const f = fixture({ phase: "draft_create", invoice: null });
  await processManual(f.env, "doc");
  assert.equal(f.row().provider_phase, "draft");
  assert.equal(f.calls.filter((x) => x.endpoint === "importInvoice").length, 1);
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 0);
});
test("an unknown existing invoice cannot be silently adopted", async () => {
  const f = fixture({ phase: "draft_create" });
  await processManual(f.env, "doc");
  assert.equal(f.row().state, "manual_review");
  assert.equal(f.calls.length, 1);
});
test("series mismatch and config drift stop before provider mutation", async () => {
  for (const drift of ["provider", "config"]) {
    const f = fixture({ transfer: "2026-10-20T12:00:00Z", enabled: true });
    if (drift === "provider") f.setInvoice({ ...draft, Pattern: "1C26OTHER" });
    else f.env.EASYINVOICE_SERIAL = "OTHER";
    await processManual(f.env, "doc");
    assert.equal(f.row().state, "manual_review");
    assert.equal(
      f.calls.filter((x) =>
        ["importInvoice", "issueInvoices"].includes(x.endpoint),
      ).length,
      0,
    );
  }
});
test("same-day actual transfer restores lines then issues the same key once; unpaid does not block", async () => {
  const f = fixture({ transfer: "2026-10-20T12:00:00Z", enabled: true });
  await processManual(f.env, "doc");
  assert.equal(f.row().state, "issued");
  assert.deepEqual(
    f.calls
      .filter((x) => ["importInvoice", "issueInvoices"].includes(x.endpoint))
      .map((x) => x.endpoint),
    ["importInvoice", "issueInvoices"],
  );
  assert.deepEqual(f.calls.find((x) => x.endpoint === "issueInvoices").body, {
    Ikeys: [draft.Ikey],
    Pattern: "1C26MAA",
    Serial: "",
  });
  await processManual(f.env, "doc");
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 1);
});
test("timeout after issue never resubmits canonical import or issue on repeated checks", async () => {
  const f = fixture({ transfer: "2026-10-20T12:00:00Z", enabled: true });
  f.setHandler((endpoint) => {
    if (endpoint === "issueInvoices") throw Error("timeout");
  });
  await processManual(f.env, "doc");
  assert.equal(f.row().state, "verify_pending");
  for (let i = 0; i < 3; i++) await processManual(f.env, "doc");
  assert.equal(f.row().state, "manual_review");
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 1);
  assert.equal(f.calls.filter((x) => x.endpoint === "importInvoice").length, 1);
});
test("successful provider issue reconciles after transport timeout without another write", async () => {
  const f = fixture({ transfer: "2026-10-20T12:00:00Z", enabled: true });
  f.setHandler((endpoint) => {
    if (endpoint === "issueInvoices") {
      f.setInvoice({
        ...draft,
        InvoiceStatus: 1,
        No: "12",
        TCTCheckStatus: "Hợp lệ",
        TaxAuthorityCode: "AUTH",
      });
      throw Error("timeout");
    }
  });
  await processManual(f.env, "doc");
  await processManual(f.env, "doc");
  assert.equal(f.row().state, "issued");
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 1);
});
test("transient read before any write safely retries draft creation", async () => {
  const f = fixture({ phase: "draft_create", invoice: null });
  let once = true;
  f.setHandler((endpoint) => {
    if (endpoint === "getInvoicesByIkeys" && once) {
      once = false;
      throw Error("timeout");
    }
  });
  await processManual(f.env, "doc");
  await processManual(f.env, "doc");
  assert.equal(f.row().provider_phase, "draft");
  assert.equal(f.calls.filter((x) => x.endpoint === "importInvoice").length, 1);
});
test("lease serializes concurrent draft creation", async () => {
  const f = fixture({ phase: "draft_create", invoice: null });
  await Promise.all([processManual(f.env, "doc"), processManual(f.env, "doc")]);
  assert.equal(f.calls.filter((x) => x.endpoint === "importInvoice").length, 1);
});
test("tax-pending archive is refreshed after explicit acceptance", async () => {
  const f = fixture({
    invoice: { ...draft, InvoiceStatus: 1, No: "12", TCTCheckStatus: -1 },
  });
  await processManual(f.env, "doc");
  assert.equal(f.row().state, "issued_archive_pending");
  const before = f.calls.filter(
    (x) => x.endpoint === "getInvoicePdf" && x.body.Option === -1,
  ).length;
  f.setInvoice({
    ...draft,
    InvoiceStatus: 1,
    No: "12",
    TCTCheckStatus: 1,
    TaxAuthorityCode: "AUTH",
  });
  await processManual(f.env, "doc");
  assert.equal(f.row().state, "issued");
  assert.equal(
    f.calls.filter(
      (x) => x.endpoint === "getInvoicePdf" && x.body.Option === -1,
    ).length,
    before + 1,
  );
});
test("provider retry code163 goes to reconciliation without repeated issue", async () => {
  const f = fixture({ transfer: "2026-10-20T12:00:00Z", enabled: true });
  f.setHandler((endpoint) =>
    endpoint === "issueInvoices"
      ? Response.json({ Status: 0, ErrorCode: 163 })
      : null,
  );
  await processManual(f.env, "doc");
  assert.equal(f.row().state, "verify_pending");
  await processManual(f.env, "doc");
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 1);
});
test("transfer requires real nonfuture timestamp and evidence; actor is recorded", async () => {
  const f = fixture();
  await processManual(f.env, "doc");
  for (const body of [
    { actual_transfer_at: "2099-01-01T00:00:00Z", evidence_ref: "x" },
    { actual_transfer_at: "2026-10-20T12:00:00Z", evidence_ref: "" },
  ])
    assert.equal((await response(f.env, "/doc/transfer", body)).status, 422);
  assert.equal(f.row().transfer_at, null);
  const r = await response(f.env, "/doc/transfer", {
    actual_transfer_at: "2026-10-20T12:00:00Z",
    evidence_ref: "customer acceptance",
  });
  assert.equal(r.status, 200);
  assert.equal(f.row().transfer_recorded_by, "session-user");
  assert.equal(f.row().state, "blocked_config");
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 0);
});
test("duplicate create returns existing row; changed facts conflict", async () => {
  const f = fixture();
  assert.equal((await response(f.env, "", order)).status, 200);
  assert.equal(
    (await response(f.env, "", { ...order, payment_method: "Paid" })).status,
    409,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM vn_einvoice_documents").get().n,
    1,
  );
});
test("worker rejects missing machine secret; scheduled run ignores verified unsigned draft", async () => {
  const f = fixture();
  assert.equal(
    (await response(f.env, "", order, { Authorization: "Bearer wrong" }))
      .status,
    401,
  );
  await processManual(f.env, "doc");
  f.calls.length = 0;
  await runManual(f.env);
  assert.equal(f.calls.length, 0);
});

test("HTTP200 HTML error cannot complete an accepted invoice archive", async () => {
  const f = fixture({
    invoice: {
      ...draft,
      InvoiceStatus: 1,
      No: "12",
      TCTCheckStatus: 1,
      TaxAuthorityCode: "AUTH",
    },
  });
  f.setHandler((endpoint, body) =>
    endpoint === "getInvoicePdf" && body.Option === -1
      ? new Response("<html>error</html>")
      : null,
  );
  await processManual(f.env, "doc");
  assert.equal(f.row().state, "issued_archive_pending");
  assert.equal(f.row().provider_xml_r2_key, null);
});

test("date-only release validates the real calendar and preserves source precision", () => {
  assert.equal(model.validTransferDate("2024-02-29"), "2024-02-29");
  assert.equal(model.validTransferMoment("2026-10-20"), "2026-10-20");
  assert.equal(model.vietnamDate("2026-10-20"), "20/10/2026");
  for (const date of [
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-10-00",
    "20/10/2026",
    "2026-10-20Z",
    "2026-10-20T00:00:00+07:00",
  ])
    assert.throws(() => model.validTransferDate(date));
});
test("date-only future validation uses Vietnam calendar day, not UTC midnight", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-25T18:30:00Z"));
  assert.equal(model.validTransferDate("2026-10-26"), "2026-10-26");
  assert.throws(() => model.validTransferDate("2026-10-27"), /future/);
});
test("explicit timestamp release retains timezone and strict time validation", () => {
  const time = "2026-10-20T23:30:00-07:00";
  assert.equal(model.validTransferMoment(time), time);
  assert.equal(model.vietnamDate(time), "21/10/2026");
  for (const value of [
    "2026-10-20T12:00:00",
    "2026-10-20T25:00:00Z",
    "2026-10-20T12:00:00+99:00",
    "2026-02-30T12:00:00Z",
  ])
    assert.throws(() => model.validTransferMoment(value));
  assert.throws(() => model.validTimestamp("2026-10-20", "captured_at"));
});
test("date-only transfer releases the same draft without inventing midnight; exact replay is idempotent", async () => {
  const f = fixture({ enabled: true });
  await processManual(f.env, "doc");
  const body = {
    actual_transfer_date: "2026-10-20",
    evidence_ref: "Confirmed full payment on 20 October and title clause",
  };
  assert.equal((await response(f.env, "/doc/transfer", body)).status, 200);
  assert.equal(f.row().transfer_at, "2026-10-20");
  assert.equal(f.row().state, "issued");
  const imported = f.calls.find((x) => x.endpoint === "importInvoice");
  assert.match(
    imported.body.XmlData,
    /<ArisingDate>20\/10\/2026<\/ArisingDate>/,
  );
  assert.ok(!imported.body.XmlData.includes("T00:00"));
  assert.equal((await response(f.env, "/doc/transfer", body)).status, 200);
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 1);
  assert.equal(
    (
      await response(f.env, "/doc/transfer", {
        actual_transfer_at: "2026-10-20T00:00:00+07:00",
        evidence_ref: body.evidence_ref,
      })
    ).status,
    409,
  );
});
test("ambiguous date-and-time or impossible date fails before recording an event", async () => {
  const f = fixture();
  await processManual(f.env, "doc");
  for (const body of [
    {
      actual_transfer_date: "2026-10-20",
      actual_transfer_at: "2026-10-20T12:00:00Z",
      evidence_ref: "source",
    },
    { actual_transfer_date: "2026-02-30", evidence_ref: "source" },
  ])
    assert.equal((await response(f.env, "/doc/transfer", body)).status, 422);
  assert.equal(f.row().transfer_at, null);
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 0);
});

test("bodyless issue pins provider ArisingDate and records explicit actor without any transfer event", async () => {
  const f = fixture({
    enabled: true,
    invoice: { ...draft, ArisingDate: "21/10/2026", IssueDate: "26/10/2026" },
  });
  await processManual(f.env, "doc");
  const responseValue = await response(f.env, "/doc/issue", {
    actual_transfer_date: "2026-10-01",
    amount: 1,
    xml_data: "caller data must be ignored",
  });
  assert.equal(responseValue.status, 200);
  assert.equal(f.row().state, "issued");
  assert.equal(f.row().transfer_at, null);
  assert.equal(f.row().transfer_evidence, null);
  assert.equal(f.row().transfer_recorded_by, null);
  const source = JSON.parse(f.objects.get(f.row().request_r2_key));
  assert.equal(source.release_request.requested_by, "session-user");
  assert.equal(source.release_request.invoice_date, "2026-10-21");
  assert.equal(source.release_request.date_source, "EasyInvoice.ArisingDate");
  assert.equal(source.release_request.provider_ikey, draft.Ikey);
  assert.ok(source.release_request.provider_readback_r2_key);
  assert.equal(source.release_request.source_request_r2_key, "source");
  assert.equal(source.order.total_gross, 298000);
  assert.ok(f.objects.has("source"));
  assert.match(
    f.calls.find((x) => x.endpoint === "importInvoice").body.XmlData,
    /<ArisingDate>21\/10\/2026<\/ArisingDate>/,
  );
  assert.equal(
    f.sql
      .prepare(
        "SELECT count(*) n FROM vn_einvoice_attempts WHERE outcome='explicit_release_requested'",
      )
      .get().n,
    1,
  );
});
test("plain reconcile and cron never turn an unsigned saved order into a release request", async () => {
  const f = fixture({ enabled: true });
  await processManual(f.env, "doc");
  await response(f.env, "/doc/reconcile", {});
  await runManual(f.env);
  assert.equal(f.row().state, "received");
  assert.equal(f.row().request_r2_key, "source");
  assert.equal(
    f.calls.filter((x) =>
      ["importInvoice", "issueInvoices"].includes(x.endpoint),
    ).length,
    0,
  );
});
test("concurrent and repeated issue clicks keep one audit request and one provider issue", async () => {
  const f = fixture({ enabled: true });
  await processManual(f.env, "doc");
  await Promise.all([
    response(f.env, "/doc/issue", undefined),
    response(f.env, "/doc/issue", undefined),
  ]);
  await response(f.env, "/doc/issue", undefined);
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 1);
  assert.equal(
    f.sql
      .prepare(
        "SELECT count(*) n FROM vn_einvoice_attempts WHERE outcome='explicit_release_requested'",
      )
      .get().n,
    1,
  );
  assert.equal(f.row().transfer_at, null);
});
test("persisted explicit request resumes with pinned invoice date after configuration recovery", async () => {
  const f = fixture({ invoice: { ...draft, ArisingDate: "21/10/2026" } });
  await processManual(f.env, "doc");
  const initial = await response(f.env, "/doc/issue", undefined);
  const initialBody = await initial.json();
  assert.equal(initialBody.document.display_status, "issuance_disabled");
  assert.equal(f.row().provider_phase, "release_requested");
  f.setInvoice({ ...draft, ArisingDate: "22/10/2026" });
  f.env.EASYINVOICE_ENABLED = "1";
  await runManual(f.env);
  assert.equal(f.row().state, "issued");
  assert.equal(f.row().transfer_at, null);
  assert.match(
    f.calls.find((x) => x.endpoint === "importInvoice").body.XmlData,
    /<ArisingDate>21\/10\/2026<\/ArisingDate>/,
  );
});
test("explicit issue timeout is reconciled only, never resubmitted or recorded as transfer", async () => {
  const f = fixture({ enabled: true });
  await processManual(f.env, "doc");
  f.setHandler((endpoint) => {
    if (endpoint === "issueInvoices") throw Error("timeout");
  });
  await response(f.env, "/doc/issue", undefined);
  await response(f.env, "/doc/issue", undefined);
  await response(f.env, "/doc/reconcile", {});
  assert.equal(f.calls.filter((x) => x.endpoint === "issueInvoices").length, 1);
  assert.equal(f.calls.filter((x) => x.endpoint === "importInvoice").length, 1);
  assert.equal(f.row().transfer_at, null);
  assert.equal(
    f.sql
      .prepare(
        "SELECT count(*) n FROM vn_einvoice_attempts WHERE outcome='explicit_release_requested'",
      )
      .get().n,
    1,
  );
});
test("invalid provider invoice date cannot fall back to IssueDate or order capture date", async () => {
  const f = fixture({
    enabled: true,
    invoice: { ...draft, ArisingDate: "31/02/2026", IssueDate: "26/10/2026" },
  });
  await processManual(f.env, "doc");
  await response(f.env, "/doc/issue", undefined);
  assert.equal(f.row().request_r2_key, "source");
  assert.equal(
    f.calls.filter((x) =>
      ["importInvoice", "issueInvoices"].includes(x.endpoint),
    ).length,
    0,
  );
  assert.equal(f.row().transfer_at, null);
});

test('persisted explicit request resumes after draft-upsert transport failure without another authorization or transfer', async()=>{
  const f=fixture({enabled:true,invoice:{...draft,ArisingDate:'21/10/2026'}});await processManual(f.env,'doc');
  let first=true;f.setHandler(endpoint=>{if(endpoint==='importInvoice'&&first){first=false;throw Error('transport timeout')}});
  await response(f.env,'/doc/issue',undefined);assert.equal(f.row().state,'verify_pending');assert.equal(f.row().provider_phase,'release_payload_sent');
  await response(f.env,'/doc/reconcile',{});assert.equal(f.row().state,'issued');assert.equal(f.row().transfer_at,null);
  assert.equal(f.calls.filter(x=>x.endpoint==='issueInvoices').length,1);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM vn_einvoice_attempts WHERE outcome='explicit_release_requested'").get().n,1);
  assert.equal(JSON.parse(f.objects.get(f.row().request_r2_key)).release_request.invoice_date,'2026-10-21');
});

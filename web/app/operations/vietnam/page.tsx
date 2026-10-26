"use client";

export const runtime = "edge";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost } from "@/lib/api";
import { getToken } from "@/lib/auth";

const BASE = "/api/integrations/vn-einvoice/orders";
const inputStyle = {
  width: "100%",
  padding: "9px 11px",
  border: "1px solid var(--line-1)",
  borderRadius: 7,
  background: "var(--paper)",
  color: "var(--fg-1)",
};
const buttonStyle = {
  padding: "10px 16px",
  borderRadius: 7,
  border: "1px solid var(--line-1)",
  background: "var(--paper)",
  cursor: "pointer",
  fontWeight: 600 as const,
};
const primary = {
  ...buttonStyle,
  background: "var(--brand-rot)",
  color: "#fff",
  borderColor: "var(--brand-rot)",
};
const card = {
  padding: 22,
  border: "1px solid var(--line-1)",
  borderRadius: 12,
  background: "var(--paper)",
};
const statusLabels: Record<string, string> = {
  draft: "Черновик · не выпущен",
  awaiting_issue: "Передача зафиксирована · ожидает выпуска",
  verifying: "Проверка результата EasyInvoice",
  issuance_disabled: "Передача зафиксирована · выпуск выключен",
  needs_attention: "Нужна проверка",
  issued_pending_tax_or_archive: "Выпущен · проверяем налоговый ответ и архив",
  tax_accepted_archived: "Принят налоговой · в архиве",
  received: "Подготовка черновика",
  submitting: "Обработка",
};
const emptyItem = () => ({
  sku: "",
  name: "",
  unit: "Tuýp",
  quantity: 1,
  gross_amount: 0,
  vat_rate: "" as number | string,
  vat_evidence_ref: "",
});
const emptyOrder = () => ({
  source_order_id: "",
  channel: "lazada",
  swifthub_order_id: "",
  source_evidence_ref: "",
  captured_at: new Date().toISOString(),
  currency: "VND",
  buyer: { kind: "business", name: "", address: "", tax_code: "" },
  payment_method: "",
  items: [emptyItem()],
  shipping_gross: 0,
  shipping_discount: 0,
  total_gross: 0,
  adopt_extraction_id: undefined as string | undefined,
});
type Order = ReturnType<typeof emptyOrder>;
type Doc = {
  id: string;
  source_order_id: string;
  display_status: string;
  provider_invoice_status: number | null;
  invoice_no: string | null;
  lookup_code: string | null;
  provider_pdf_r2_key: string | null;
  provider_xml_r2_key: string | null;
  provider_message: string | null;
  transfer_at: string | null;
  transfer_evidence: string | null;
  provider_check: {
    available: boolean;
    invoice_status: number | null;
    invoice_no: string | null;
    tax_status_raw: string | null;
    tax_error: string | null;
    tax_authority_code: string | null;
    checked_at: number | null;
  };
  accounting_document: {
    id: string;
    status: string;
    reviewed_at: number | null;
    target_id: string | null;
  } | null;
  order: Order;
  fiscal_lines: Array<
    Order["items"][number] & { net_amount: number; vat_amount: number }
  >;
  fiscal_totals: { net: number; vat: number; gross: number };
  source_facts: {
    order_created_at: string | null;
    draft_date: string | null;
    carrier: string | null;
    tracking_number: string | null;
  };
};
function providerInvoiceLabel(status: number | null | undefined) {
  return (
    (
      {
        "-1": "Ожидает подписи",
        "0": "Черновик, не выпущен",
        "1": "Выпущен",
        "2": "Выпущен, задекларирован",
        "3": "Заменён",
        "4": "Скорректирован",
        "5": "Аннулирован",
        "6": "Одобрен для подписи",
      } as Record<string, string>
    )[String(status)] ?? "Нет подтверждённых данных"
  );
}
function providerTaxLabel(check: Doc["provider_check"]) {
  if (!check?.available) return "Нет подтверждённых данных";
  if (check.tax_error) return `Ошибка: ${check.tax_error}`;
  const status = check.tax_status_raw;
  if (["-2", "Không hợp lệ"].includes(status ?? ""))
    return "Отклонено налоговой";
  if (["1", "Hợp lệ"].includes(status ?? ""))
    return check.tax_authority_code
      ? "Принято налоговой"
      : "Проверка успешна; код налоговой не подтверждён";
  if (["-1", "Đang kiểm tra"].includes(status ?? ""))
    return "Проверяется налоговой";
  if (["0", "Chưa xử lý"].includes(status ?? "")) return "Ещё не обработано";
  if (status === "Chưa gửi thuế") return "Не отправлено в налоговую";
  return status
    ? `Статус EasyInvoice: ${status}`
    : "Статус отправки не подтверждён";
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
      {label}
      {children}
    </label>
  );
}
function errorMessage(code: string) {
  return (
    (
      {
        existing_order_differs:
          "Заказ уже сохранён с другими данными. Откройте сохранённый заказ.",
        provider_fiscal_facts_mismatch:
          "Данные черновика отличаются от заказа. Проверьте покупателя и суммы.",
        nonzero_shipping_requires_fiscal_line_mapping:
          "Для платной доставки требуется подтверждённая строка с налоговой ставкой.",
        mixed_rates_require_template_mapping:
          "Для разных ставок НДС требуется подтверждённый шаблон.",
        order_total_mismatch: "Итог заказа должен совпадать с суммой строк.",
        verified_draft_required:
          "Дождитесь проверки черновика перед фиксацией передачи.",
      } as Record<string, string>
    )[code] ?? "Не удалось обработать запрос. Проверьте данные. Код: " + code
  );
}
export default function VietnamInvoices() {
  const [docs, setDocs] = useState<Doc[]>([]),
    [saved, setSaved] = useState<Array<{ id: string; filename: string }>>([]);
  const [order, setOrder] = useState<Order>(emptyOrder),
    [showForm, setShowForm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [transferFor, setTransferFor] = useState<string | null>(null),
    [transferAt, setTransferAt] = useState(""),
    [evidence, setEvidence] = useState("");
  const load = useCallback(async () => {
    const r = await apiGet<{
      documents: Doc[];
      saved_drafts: Array<{ id: string; filename: string }>;
    }>(BASE);
    if (r.success && r.result) {
      setDocs(r.result.documents);
      setSaved(r.result.saved_drafts);
    } else setError(r.errors?.[0]?.message ?? "Не удалось загрузить счета");
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);
  const change = (key: keyof Order, value: any) =>
    setOrder((p) => ({ ...p, [key]: value }));
  const itemChange = (index: number, key: string, value: any) =>
    setOrder((p) => ({
      ...p,
      items: p.items.map((x, i) => (i === index ? { ...x, [key]: value } : x)),
    }));
  async function adopt(id: string) {
    setError("");
    const r = await apiGet<{ order: Order }>(
      `${BASE}/source/${encodeURIComponent(id)}`,
    );
    if (r.success && r.result) {
      setOrder(r.result.order);
      setShowForm(true);
    } else setError(r.errors?.[0]?.message ?? "Не удалось открыть черновик");
  }
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await apiPost<any>(path, body);
      if (!r.success)
        throw new Error(
          r.errors?.[0]?.message ?? "Не удалось выполнить запрос",
        );
      await load();
      return r.result;
    } catch (e) {
      setError(
        errorMessage(
          e instanceof Error ? e.message : "Не удалось выполнить запрос",
        ),
      );
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const data = {
      ...order,
      items: order.items.map((x) => ({
        ...x,
        quantity: Number(x.quantity),
        gross_amount: Number(x.gross_amount),
        vat_rate: x.vat_rate === "" ? null : Number(x.vat_rate),
      })),
    };
    const r = await action(BASE, data);
    if (r) {
      setShowForm(false);
      setOrder(emptyOrder());
      setNotice(
        r.document?.display_status === "draft"
          ? "Заказ сохранён, черновик подготовлен."
          : "Заказ сохранён. " +
              (statusLabels[r.document?.display_status] ??
                "Проверяем результат."),
      );
    }
  }
  async function confirmTransfer() {
    if (!transferFor) return;
    const r = await action(`${BASE}/${transferFor}/transfer`, {
      actual_transfer_at: `${transferAt}:00+07:00`,
      evidence_ref: evidence,
    });
    if (r) {
      setTransferFor(null);
      setTransferAt("");
      setEvidence("");
      setNotice(
        "Передача зафиксирована. " +
          (statusLabels[r.document?.display_status] ?? "Проверяем результат."),
      );
    }
  }
  async function download(id: string, kind: string) {
    setError("");
    try {
      const r = await fetch(
        `https://dasoperator-api.dasexperten.workers.dev${BASE}/${id}/file/${kind}`,
        { headers: { Authorization: `Bearer ${getToken() ?? ""}` } },
      );
      if (!r.ok) throw new Error("Файл пока недоступен");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${id}.${kind}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось скачать файл");
    }
  }
  const sum = order.items.reduce((s, x) => s + Number(x.gross_amount || 0), 0);
  return (
    <div
      style={{
        maxWidth: 1160,
        margin: "0 auto",
        display: "grid",
        gap: 20,
        padding: "20px 8px",
      }}
    >
      <div>
        <Link href="/operations" style={{ color: "var(--fg-3)", fontSize: 13 }}>
          ← Операции
        </Link>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            alignItems: "center",
            marginTop: 10,
          }}
        >
          <div>
            <h1 style={{ fontSize: 27, fontWeight: 750 }}>
              Электронные счета Вьетнам
            </h1>
            <p style={{ color: "var(--fg-2)", marginTop: 6 }}>
              Сохраните заказ, затем зафиксируйте фактическую передачу
              покупателю для выпуска счёта.
            </p>
          </div>
          <button
            style={primary}
            onClick={() => {
              setOrder(emptyOrder());
              setShowForm(true);
            }}
          >
            Ввести заказ вручную
          </button>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          style={{
            ...card,
            borderColor: "var(--brand-rot)",
            color: "var(--brand-rot)",
          }}
        >
          {error}
        </div>
      )}
      {notice && (
        <div role="status" style={{ ...card, color: "#267348" }}>
          {notice}
        </div>
      )}
      {saved.length > 0 && (
        <div style={card}>
          <h2 style={{ fontWeight: 700 }}>Подготовленные черновики</h2>
          {saved.map((x) => (
            <div
              key={x.id}
              style={{
                display: "flex",
                gap: 14,
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 12,
              }}
            >
              <span>{x.filename}</span>
              <button style={buttonStyle} onClick={() => adopt(x.id)}>
                Открыть черновик
              </button>
            </div>
          ))}
        </div>
      )}
      {showForm && (
        <section style={{ ...card, display: "grid", gap: 18 }}>
          <h2 style={{ fontSize: 19, fontWeight: 700 }}>
            {order.adopt_extraction_id
              ? "Подключить существующий черновик"
              : "Данные заказа"}
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
              gap: 14,
            }}
          >
            <Field label="Номер заказа маркетплейса">
              <input
                style={inputStyle}
                value={order.source_order_id}
                onChange={(e) => change("source_order_id", e.target.value)}
              />
            </Field>
            <Field label="Канал">
              <select
                style={inputStyle}
                value={order.channel}
                onChange={(e) => change("channel", e.target.value)}
              >
                {["lazada", "shopee", "tiktok", "manual"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label="Номер SwiftHub (необязательно)">
              <input
                style={inputStyle}
                value={order.swifthub_order_id ?? ""}
                onChange={(e) => change("swifthub_order_id", e.target.value)}
              />
            </Field>
            <Field label="Источник заказа / подтверждение">
              <input
                style={inputStyle}
                value={order.source_evidence_ref}
                onChange={(e) => change("source_evidence_ref", e.target.value)}
              />
            </Field>
            <Field label="Тип покупателя">
              <select
                style={inputStyle}
                value={order.buyer.kind}
                onChange={(e) =>
                  change("buyer", { ...order.buyer, kind: e.target.value })
                }
              >
                <option value="business">Компания</option>
                <option value="consumer">Физическое лицо</option>
              </select>
            </Field>
            <Field label="Имя / наименование покупателя">
              <input
                style={inputStyle}
                value={order.buyer.name}
                onChange={(e) =>
                  change("buyer", { ...order.buyer, name: e.target.value })
                }
              />
            </Field>
            <Field label="Адрес покупателя">
              <input
                style={inputStyle}
                value={order.buyer.address}
                onChange={(e) =>
                  change("buyer", { ...order.buyer, address: e.target.value })
                }
              />
            </Field>
            <Field
              label={
                order.buyer.kind === "business"
                  ? "Налоговый номер покупателя"
                  : "Налоговый номер (необязательно)"
              }
            >
              <input
                style={inputStyle}
                value={order.buyer.tax_code ?? ""}
                onChange={(e) =>
                  change("buyer", { ...order.buyer, tax_code: e.target.value })
                }
              />
            </Field>
            <Field label="Способ оплаты">
              <input
                style={inputStyle}
                value={order.payment_method}
                onChange={(e) => change("payment_method", e.target.value)}
                placeholder="Например, Mixedcard (Lazada)"
              />
            </Field>
          </div>
          <h3 style={{ fontWeight: 700 }}>
            Товары · суммы включают НДС, в VND
          </h3>
          {order.items.map((x, i) => (
            <div
              key={i}
              style={{
                padding: 14,
                border: "1px solid var(--line-1)",
                borderRadius: 8,
                display: "grid",
                gap: 12,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))",
                  gap: 10,
                }}
              >
                <Field label="SKU">
                  <input
                    style={inputStyle}
                    value={x.sku}
                    onChange={(e) => itemChange(i, "sku", e.target.value)}
                  />
                </Field>
                <Field label="Название товара в счёте">
                  <input
                    style={inputStyle}
                    value={x.name}
                    onChange={(e) => itemChange(i, "name", e.target.value)}
                  />
                </Field>
                <Field label="Единица">
                  <input
                    style={inputStyle}
                    value={x.unit}
                    onChange={(e) => itemChange(i, "unit", e.target.value)}
                  />
                </Field>
                <Field label="Количество">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    style={inputStyle}
                    value={x.quantity}
                    onChange={(e) =>
                      itemChange(i, "quantity", Number(e.target.value))
                    }
                  />
                </Field>
                <Field label="Сумма строки с НДС, VND">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    style={inputStyle}
                    value={x.gross_amount || ""}
                    onChange={(e) =>
                      itemChange(i, "gross_amount", Number(e.target.value))
                    }
                  />
                </Field>
                <Field label="Подтверждённый НДС, %">
                  <select
                    style={inputStyle}
                    value={x.vat_rate}
                    onChange={(e) =>
                      itemChange(
                        i,
                        "vat_rate",
                        e.target.value === "" ? "" : Number(e.target.value),
                      )
                    }
                  >
                    <option value="">Выберите ставку</option>
                    {[0, 5, 8, 10].map((v) => (
                      <option value={v} key={v}>
                        {v}%
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Основание НДС / дата действия">
                <textarea
                  rows={2}
                  style={inputStyle}
                  value={x.vat_evidence_ref}
                  onChange={(e) =>
                    itemChange(i, "vat_evidence_ref", e.target.value)
                  }
                />
              </Field>
              {order.items.length > 1 && (
                <button
                  style={{ ...buttonStyle, justifySelf: "start" }}
                  onClick={() =>
                    change(
                      "items",
                      order.items.filter((_, n) => n !== i),
                    )
                  }
                >
                  Удалить строку
                </button>
              )}
            </div>
          ))}
          <button
            style={{ ...buttonStyle, justifySelf: "start" }}
            onClick={() => change("items", [...order.items, emptyItem()])}
          >
            Добавить товар
          </button>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))",
              gap: 14,
            }}
          >
            <Field label="Доставка до скидки, VND">
              <input
                type="number"
                min="0"
                style={inputStyle}
                value={order.shipping_gross}
                onChange={(e) =>
                  change("shipping_gross", Number(e.target.value))
                }
              />
            </Field>
            <Field label="Скидка на доставку, VND">
              <input
                type="number"
                min="0"
                style={inputStyle}
                value={order.shipping_discount}
                onChange={(e) =>
                  change("shipping_discount", Number(e.target.value))
                }
              />
            </Field>
            <Field label="Подтверждённый итог, VND">
              <input
                type="number"
                min="1"
                style={inputStyle}
                value={order.total_gross || ""}
                onChange={(e) => change("total_gross", Number(e.target.value))}
              />
            </Field>
          </div>
          <p style={{ fontSize: 13, color: "var(--fg-2)" }}>
            Сумма товаров: {sum.toLocaleString()} VND. Доставка после скидки:{" "}
            {(order.shipping_gross - order.shipping_discount).toLocaleString()}{" "}
            VND.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button disabled={busy} style={primary} onClick={save}>
              {busy
                ? "Подготовка…"
                : order.adopt_extraction_id
                  ? "Подключить черновик"
                  : "Сохранить заказ и подготовить черновик"}
            </button>
            <button
              style={buttonStyle}
              disabled={busy}
              onClick={() => setShowForm(false)}
            >
              Закрыть
            </button>
          </div>
        </section>
      )}
      {docs.map((d) => (
        <article key={d.id} style={{ ...card, display: "grid", gap: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ fontSize: 19, fontWeight: 700 }}>
                {d.order.channel} · {d.source_order_id}
              </h2>
              <p style={{ color: "var(--fg-2)", marginTop: 5 }}>
                {d.order.buyer.name} · {d.order.total_gross.toLocaleString()}{" "}
                VND
              </p>
            </div>
            <strong
              style={{
                color:
                  d.provider_check?.available &&
                  !d.provider_check.tax_error &&
                  ["1", "Hợp lệ"].includes(
                    d.provider_check.tax_status_raw ?? "",
                  ) &&
                  d.provider_check.tax_authority_code
                    ? "#267348"
                    : "#986b12",
              }}
            >
              {providerInvoiceLabel(d.provider_check?.invoice_status)}
            </strong>
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-2)" }}>
            Счёт:{" "}
            {!d.provider_check?.available
              ? "номер не подтверждён"
              : d.provider_check.invoice_no &&
                  d.provider_check.invoice_no !== "0"
                ? d.provider_check.invoice_no
                : "номер не присвоен"}{" "}
            · Код поиска: {d.lookup_code ?? "ожидается"}
            {d.transfer_at && (
              <>
                {" "}
                · Фактическая передача:{" "}
                {new Date(d.transfer_at).toLocaleString("ru-RU", {
                  timeZone: "Asia/Ho_Chi_Minh",
                })}{" "}
                Вьетнам
              </>
            )}
          </div>
          <section
            aria-label="Статусы выпуска, налоговой и бухгалтерии"
            style={{
              padding: 16,
              border: "1px solid var(--line-1)",
              borderRadius: 8,
              display: "grid",
              gap: 10,
            }}
          >
            <div>
              <strong>Выпуск:</strong>{" "}
              {providerInvoiceLabel(d.provider_check?.invoice_status)}
              {d.provider_check?.invoice_no &&
              d.provider_check.invoice_no !== "0"
                ? ` · № ${d.provider_check.invoice_no}`
                : ""}
            </div>
            <div>
              <strong>Налоговая:</strong> {providerTaxLabel(d.provider_check)}
              {d.provider_check?.tax_authority_code && (
                <span> · Код: {d.provider_check.tax_authority_code}</span>
              )}
            </div>
            <p style={{ fontSize: 12, color: "var(--fg-2)" }}>
              Последняя подтверждённая сверка с EasyInvoice:{" "}
              {d.provider_check?.checked_at
                ? new Date(d.provider_check.checked_at * 1000).toLocaleString(
                    "ru-RU",
                    { timeZone: "Asia/Yerevan" },
                  ) + " (Ереван)"
                : "нет доступного подтверждения"}
              . Отображён сохранённый результат сверки.
            </p>
            <div>
              <strong>Учёт / бухгалтерия:</strong>{" "}
              {d.accounting_document?.status === "pending_review" &&
              !d.accounting_document.reviewed_at &&
              !d.accounting_document.target_id
                ? "Документ ERP ожидает проверки; подтверждение передачи бухгалтеру в этой записи не зарегистрировано."
                : "Подтверждённый статус передачи бухгалтеру в этой записи отсутствует."}
              {d.accounting_document && (
                <>
                  {" "}
                  <Link
                    href={`/inbox/documents/${encodeURIComponent(d.accounting_document.id)}`}
                    style={{ textDecoration: "underline" }}
                  >
                    Открыть документ ERP
                  </Link>
                </>
              )}
            </div>
          </section>
          <section
            aria-label="Данные из заказа и черновика"
            style={{ display: "grid", gap: 12 }}
          >
            <p style={{ fontSize: 13, color: "var(--fg-2)" }}>
              Данные из сохранённого заказа и черновика.
            </p>
            <div
              style={{
                display: "flex",
                gap: 20,
                flexWrap: "wrap",
                fontSize: 14,
              }}
            >
              {d.source_facts?.order_created_at && (
                <span>
                  Дата заказа:{" "}
                  <strong>
                    {new Date(d.source_facts.order_created_at).toLocaleString(
                      "ru-RU",
                      { timeZone: "Asia/Ho_Chi_Minh" },
                    )}
                  </strong>{" "}
                  (Вьетнам)
                </span>
              )}
              {d.source_facts?.draft_date && (
                <span>
                  Дата черновика EasyInvoice:{" "}
                  <strong>{d.source_facts.draft_date}</strong>
                </span>
              )}
              {d.source_facts?.tracking_number && (
                <span>
                  {d.source_facts.carrier}:{" "}
                  <strong>{d.source_facts.tracking_number}</strong>
                </span>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                }}
              >
                <caption
                  style={{
                    textAlign: "left",
                    paddingBottom: 8,
                    color: "var(--fg-2)",
                  }}
                >
                  Товары и суммы в VND
                </caption>
                <thead>
                  <tr>
                    {["Товар", "Количество", "Без НДС", "НДС", "С НДС"].map(
                      (label) => (
                        <th
                          key={label}
                          style={{
                            textAlign: "left",
                            padding: "8px 10px",
                            borderBottom: "1px solid var(--line-1)",
                          }}
                        >
                          {label}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {d.fiscal_lines?.map((line, index) => (
                    <tr key={index}>
                      <td style={{ padding: "10px" }}>
                        <strong>{line.sku}</strong>
                        <br />
                        {line.name}
                      </td>
                      <td style={{ padding: "10px" }}>
                        {line.quantity} {line.unit}
                      </td>
                      <td style={{ padding: "10px", whiteSpace: "nowrap" }}>
                        {line.net_amount.toLocaleString("ru-RU")}
                      </td>
                      <td style={{ padding: "10px", whiteSpace: "nowrap" }}>
                        {line.vat_amount.toLocaleString("ru-RU")} (
                        {line.vat_rate}%)
                      </td>
                      <td style={{ padding: "10px", whiteSpace: "nowrap" }}>
                        {line.gross_amount.toLocaleString("ru-RU")}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {d.fiscal_totals && (
                  <tfoot>
                    <tr
                      style={{
                        fontWeight: 700,
                        borderTop: "1px solid var(--line-1)",
                      }}
                    >
                      <td colSpan={2} style={{ padding: 10 }}>
                        Итого
                      </td>
                      <td style={{ padding: 10 }}>
                        {d.fiscal_totals.net.toLocaleString("ru-RU")}
                      </td>
                      <td style={{ padding: 10 }}>
                        {d.fiscal_totals.vat.toLocaleString("ru-RU")}
                      </td>
                      <td style={{ padding: 10 }}>
                        {d.fiscal_totals.gross.toLocaleString("ru-RU")}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <p style={{ fontSize: 13, color: "var(--fg-2)" }}>
              Доставка: {d.order.shipping_gross.toLocaleString("ru-RU")} −
              скидка {d.order.shipping_discount.toLocaleString("ru-RU")} ={" "}
              {(
                d.order.shipping_gross - d.order.shipping_discount
              ).toLocaleString("ru-RU")}{" "}
              VND. Способ оплаты: {d.order.payment_method}.
            </p>
          </section>
          {d.display_status === "needs_attention" && (
            <p role="alert" style={{ color: "var(--brand-rot)" }}>
              {errorMessage(
                d.provider_message ?? "Проверьте данные EasyInvoice",
              )}
            </p>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {d.provider_pdf_r2_key && (
              <button style={buttonStyle} onClick={() => download(d.id, "pdf")}>
                Скачать {d.provider_invoice_status === 0 ? "черновик " : ""}PDF
              </button>
            )}
            {d.provider_xml_r2_key && (
              <button style={buttonStyle} onClick={() => download(d.id, "xml")}>
                Скачать XML выпущенного счёта
              </button>
            )}
            <button
              disabled={busy}
              style={buttonStyle}
              onClick={() => action(`${BASE}/${d.id}/reconcile`, {})}
            >
              Проверить EasyInvoice
            </button>
            {d.display_status === "draft" && !d.transfer_at && (
              <button
                disabled={busy}
                style={primary}
                onClick={() => {
                  setTransferFor(d.id);
                  setTransferAt("");
                  setEvidence("");
                }}
              >
                Зафиксировать передачу
              </button>
            )}
          </div>
          {transferFor === d.id && (
            <div
              style={{
                padding: 16,
                background: "var(--paper-sunk)",
                borderRadius: 8,
                display: "grid",
                gap: 14,
              }}
            >
              <p>
                Основание выпуска — подтверждённый переход права собственности
                или пользования по условиям заказа. Если договор связывает его с
                полной оплатой, используйте подтверждённую дату оплаты. Ожидать
                статус «Доставлен» в таком случае не требуется.
              </p>
              <Field label="Момент перехода права · Вьетнам (UTC+7)">
                <input
                  type="datetime-local"
                  style={inputStyle}
                  value={transferAt}
                  onChange={(e) => setTransferAt(e.target.value)}
                />
              </Field>
              <Field label="Основание перехода собственности / передачи товара">
                <textarea
                  rows={2}
                  style={inputStyle}
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder="Подтверждение оплаты, условие договора, акт или ссылка на источник"
                />
              </Field>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  disabled={busy || !transferAt || !evidence.trim()}
                  style={primary}
                  onClick={confirmTransfer}
                >
                  {busy
                    ? "Обработка…"
                    : "Подтвердить основание и выпустить счёт"}
                </button>
                <button
                  style={buttonStyle}
                  onClick={() => setTransferFor(null)}
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </article>
      ))}
      {!docs.length && !showForm && (
        <p style={{ color: "var(--fg-2)" }}>
          Заказов пока нет. Откройте подготовленный черновик или добавьте заказ.
        </p>
      )}
    </div>
  );
}

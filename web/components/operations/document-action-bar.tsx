'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, FileText, Package, FileCheck, Truck, Wrench, Box, CheckCircle2 } from 'lucide-react';
import { issueDocuments } from '@/lib/api';
import ServiceStatusBar from './service-status-bar';

interface DocumentActionBarProps {
  operationId: string;
  operationStatus: string;
  operationType?: string;
  partnerCountry?: string | null;
  ourCompanyAbbr?: string | null;
  /** Warehouse-to code (e.g. 'GZH', 'YZH', 'FLP'). Used to disable Shipped
   * on purchase ops when goods stay at the factory's own warehouse —
   * Guangzhou → Guangzhou has no transit step. */
  warehouseCode?: string | null;
  /**
   * Set of document types ('CI', 'PL', 'IS', 'UPD', 'TN') that already exist
   * for this operation in 'issued' status. Buttons for these types are
   * disabled — user must delete the doc in the Documents tab to re-issue.
   */
  issuedDocTypes?: Set<string>;
  onIssued: () => Promise<void> | void;
  /** Called after a successful status change so the parent refetches
   * operation + stock movements. */
  onStatusChange?: () => Promise<void> | void;
  // ── Service track (added 2026-05-13, migration 0034) ──────────────────────
  /** 'goods' (default) renders the existing CI · PL · IS · RFQ · Production ·
   *  Shipped · Delivered bar. 'service' renders the two-chip ServiceStatusBar
   *  and skips the entire goods toolbar.                                     */
  operationTrack?: 'goods' | 'service';
  /** Existing operations.delivery_status — drives Service provided chip */
  deliveryStatus?: 'pending' | 'delivered' | 'disputed' | 'refunded';
  /** Sum of confirmed payments for this operation, operation currency */
  paidAmount?: number | null;
  /** operations.total_amount, operation currency */
  totalAmount?: number | null;
}

type DocType = 'CI' | 'PL' | 'IS-V1' | 'IS-V2' | 'UPD' | 'TN';
type ButtonId = 'CI' | 'PL' | 'IS' | 'UPD' | 'TN' | 'FREIGHT' | 'PROD' | 'BOX' | 'SHIP' | 'DELIV';

/** Factory warehouses where Shipped step is a no-op (goods stay put). */
const FACTORY_WAREHOUSE_CODES = new Set(['GZH', 'YZH']);

export default function DocumentActionBar({
  operationId,
  operationStatus,
  operationType = 'sale',
  partnerCountry,
  ourCompanyAbbr,
  warehouseCode,
  issuedDocTypes,
  onIssued,
  onStatusChange,
  operationTrack = 'goods',
  deliveryStatus = 'delivered',
  paidAmount = null,
  totalAmount = null,
}: DocumentActionBarProps) {
  const [busy, setBusy] = useState<ButtonId | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // ── Service track short-circuit ─────────────────────────────────────────
  // Service operations (auditors, logistics, agencies) skip the goods
  // toolbar entirely and show the two-chip ServiceStatusBar instead.
  // Placed AFTER all hook declarations to satisfy Rules of Hooks even though
  // operationTrack never changes mid-mount.
  if (operationTrack === 'service') {
    return (
      <ServiceStatusBar
        deliveryStatus={deliveryStatus}
        paidAmount={paidAmount}
        totalAmount={totalAmount}
      />
    );
  }

  const canIssue = operationStatus !== 'cancelled';
  const issued = issuedDocTypes ?? new Set<string>();

  // Per-type disable flags. UI hint: once a doc is issued, you must delete it
  // in the Documents tab before pressing the button again. The backend
  // duplicate-guard (already_exists 409) is the safety-net.
  const ciIssued = issued.has('CI');
  const plIssued = issued.has('PL');
  const isIssued = issued.has('IS');
  const updIssued = issued.has('UPD');
  const tnIssued = issued.has('TN');

  // -------------------- Status-transition flags --------------------
  // Backend uses 'production' / 'order_fulfilment' as canonical names.
  // UI shows them as Production / Boxing per Aram's vocabulary.
  const isPurchase = operationType === 'purchase';
  const isSale = operationType === 'sale';

  // Production / Boxing — both flow from 'issued' (after docs created)
  const prodActive = isPurchase && operationStatus === 'issued';
  const boxActive = isSale && operationStatus === 'issued';
  // Shipped — from production (purchase) or order_fulfilment (sale)
  // For purchase, also disable when warehouse is a factory (no transit needed).
  const shipFromProd = isPurchase && operationStatus === 'production';
  const shipFromBox = isSale && operationStatus === 'order_fulfilment';
  const isFactoryWarehouse = warehouseCode ? FACTORY_WAREHOUSE_CODES.has(warehouseCode.toUpperCase()) : false;
  const shipActive = (shipFromProd && !isFactoryWarehouse) || shipFromBox;
  const shipBlockedByFactory = shipFromProd && isFactoryWarehouse;
  // Delivered — only for purchase, from shipped (or directly from production
  // when factory-warehouse case skips Shipped)
  const delivActive = isPurchase && (operationStatus === 'shipped' || (operationStatus === 'production' && isFactoryWarehouse));

  // Detect Russian sale to switch button set to UPD + TN.
  // УПД и ТН — это исключительно документы DEE.
  // Другие компании (DEI, DEASEAN) на любого покупателя выпускают CI + PL.
  const isRussianSale = operationType === 'sale' &&
    (partnerCountry === 'Russia' || partnerCountry === 'Russian Federation' || partnerCountry === 'RU') &&
    ourCompanyAbbr === 'DEE';

  const handleIssue = async (id: ButtonId, types?: DocType[]) => {
    if (!canIssue) {
      setFeedback({ type: 'error', text: `Cannot issue documents — operation status is ${operationStatus}` });
      return;
    }
    setBusy(id);
    setFeedback(null);
    try {
      const res = await issueDocuments(operationId, types);
      if (res.success && res.result) {
        const issued = (res.result as any).documents?.map((d: any) => d.reference).join(', ') ?? 'documents';
        setFeedback({ type: 'success', text: `Issued: ${issued}` });
        await onIssued();
      } else {
        setFeedback({ type: 'error', text: res.errors?.[0]?.message ?? 'Failed to issue' });
      }
    } catch (e) {
      setFeedback({ type: 'error', text: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const handleStatusChange = async (id: ButtonId, targetStatus: string, label: string) => {
    if (!window.confirm(`Move operation to ${label}?`)) return;
    setBusy(id);
    setFeedback(null);
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
      const r = await fetch(`${API_BASE}/api/operations/${operationId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: targetStatus }),
      });
      const data = await r.json();
      if (!r.ok || !data.success) {
        setFeedback({ type: 'error', text: data.errors?.[0]?.message ?? `Failed (HTTP ${r.status})` });
        return;
      }
      setFeedback({ type: 'success', text: `Moved to ${label}` });
      if (onStatusChange) await onStatusChange();
    } catch (e) {
      setFeedback({ type: 'error', text: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 14px',
    fontSize: '14px',
    fontWeight: 600,
    border: '1px solid var(--border-hairline)',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: active ? 'var(--paper)' : 'var(--paper-sunk)',
    color: active ? 'var(--fg-1)' : 'var(--fg-3)',
    cursor: !canIssue || busy ? 'not-allowed' : 'pointer',
    opacity: !canIssue || busy ? 0.5 : 1,
    transition: 'all 150ms',
  });

  /** Status-transition buttons get coloured fills when active to signal the
   * destination state. Disabled state mirrors buttonStyle's grey/sunken
   * variant so the bar reads consistently. */
  const statusButtonStyle = (
    active: boolean,
    bgActive: string,
    borderActive: string,
    fgActive: string,
  ): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 14px',
    fontSize: '14px',
    fontWeight: 600,
    border: `1px solid ${active ? borderActive : 'var(--border-hairline)'}`,
    borderRadius: 'var(--radius-sm)',
    backgroundColor: active ? bgActive : 'var(--paper-sunk)',
    color: active ? fgActive : 'var(--fg-3)',
    cursor: !active || busy ? 'not-allowed' : 'pointer',
    opacity: !active || busy ? 0.55 : 1,
    transition: 'all 150ms',
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        {isRussianSale ? (
          <>
            <button
              onClick={() => handleIssue('UPD', ['UPD'])}
              disabled={!canIssue || !!busy || updIssued}
              style={buttonStyle(canIssue && !updIssued)}
              title={updIssued
                ? 'УПД уже выпущен — удалите его во вкладке Documents чтобы выпустить заново'
                : 'Универсальный передаточный документ'}
            >
              {busy === 'UPD' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              УПД
            </button>
            <button
              onClick={() => handleIssue('TN', ['TN'])}
              disabled={!canIssue || !!busy || tnIssued}
              style={buttonStyle(canIssue && !tnIssued)}
              title={tnIssued
                ? 'ТН уже выпущена — удалите её во вкладке Documents чтобы выпустить заново'
                : 'Транспортная накладная'}
            >
              {busy === 'TN' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
              ТН
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => handleIssue('CI', ['CI'])}
              disabled={!canIssue || !!busy || ciIssued}
              style={buttonStyle(canIssue && !ciIssued)}
              title={ciIssued
                ? 'CI already issued — delete it in the Documents tab to re-issue'
                : 'Generate Commercial Invoice'}
            >
              {busy === 'CI' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              CI
            </button>
            <button
              onClick={() => handleIssue('PL', ['PL'])}
              disabled={!canIssue || !!busy || plIssued}
              style={buttonStyle(canIssue && !plIssued)}
              title={plIssued
                ? 'PL already issued — delete it in the Documents tab to re-issue'
                : 'Generate Packing List'}
            >
              {busy === 'PL' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
              PL
            </button>
            <button
              onClick={() => handleIssue('IS', ['IS-V1', 'IS-V2'])}
              disabled={!canIssue || !!busy || isIssued}
              style={buttonStyle(canIssue && !isIssued)}
              title={isIssued
                ? 'IS already issued — delete it in the Documents tab to re-issue'
                : 'Generate Issuance Statement'}
            >
              {busy === 'IS' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck className="h-4 w-4" />}
              IS
            </button>
          </>
        )}
        {/* RFQ — Request For Quote to a freight forwarder. Only relevant for
            purchase ops (goods moving from manufacturer → our warehouse).
            Sale ops ship from our warehouse using our existing logistics,
            so RFQ doesn't apply. */}
        {operationType === 'purchase' && (
          <Link
            href={`/operations/${operationId}/freight-rfq`}
            style={{
              ...buttonStyle(true),
              cursor: 'pointer',
              opacity: 1,
              textDecoration: 'none',
              backgroundColor: 'var(--paper)',
              color: 'var(--fg-1)',
            }}
            title="Send freight forwarding request to a shipper (Request For Quote)"
          >
            <Truck className="h-4 w-4" />
            RFQ
          </Link>
        )}

        {/* Status-transition buttons. Each is active only when the operation
            is in the immediately-preceding status. Colours encode the target
            status; disabled buttons are greyed out the same way as document
            buttons (no per-state colour change) to keep one disabled style. */}
        {isPurchase && (
          <button
            onClick={() => handleStatusChange('PROD', 'production', 'Production')}
            disabled={!prodActive || !!busy}
            style={statusButtonStyle(prodActive, '#FAEEDA', '#BA7517', '#854F0B')}
            title={prodActive
              ? 'Move to In Production — generates +qty pending stock at the operation warehouse'
              : `Production button activates when operation is in 'issued' status`}
          >
            {busy === 'PROD' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
            Production
          </button>
        )}
        {isSale && (
          <button
            onClick={() => handleStatusChange('BOX', 'order_fulfilment', 'Boxing')}
            disabled={!boxActive || !!busy}
            style={statusButtonStyle(boxActive, '#FAEEDA', '#BA7517', '#854F0B')}
            title={boxActive
              ? 'Move to Boxing — reserves -qty pending stock at the operation warehouse'
              : `Boxing button activates when operation is in 'issued' status`}
          >
            {busy === 'BOX' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Box className="h-4 w-4" />}
            Boxing
          </button>
        )}
        <button
          onClick={() => handleStatusChange('SHIP', 'shipped', 'Shipped')}
          disabled={!shipActive || !!busy}
          style={statusButtonStyle(shipActive, '#E6F1FB', '#185FA5', '#0C447C')}
          title={
            shipBlockedByFactory
              ? `Shipped doesn't apply — goods stay at the factory warehouse (${warehouseCode}). Use Delivered to receive them.`
              : shipActive
              ? 'Move to Shipped — goods left the source warehouse'
              : `Shipped button activates after ${isPurchase ? 'Production' : 'Boxing'}`
          }
        >
          {busy === 'SHIP' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
          Shipped
        </button>
        {isPurchase && (
          <button
            onClick={() => handleStatusChange('DELIV', 'delivered', 'Delivered')}
            disabled={!delivActive || !!busy}
            style={statusButtonStyle(delivActive, '#E1F5EE', '#0F6E56', '#085041')}
            title={delivActive
              ? 'Move to Delivered — converts pending stock to actual stock at the destination warehouse'
              : `Delivered button activates after Shipped${isFactoryWarehouse ? ' (or directly from Production for factory warehouses)' : ''}`}
          >
            {busy === 'DELIV' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Delivered
          </button>
        )}
      </div>
      {feedback && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: feedback.type === 'success' ? 'rgba(46,125,79,0.08)' : 'rgba(229,32,44,0.08)',
            border: `1px solid ${feedback.type === 'success' ? 'rgba(46,125,79,0.3)' : 'rgba(229,32,44,0.3)'}`,
          }}
        >
          <p style={{
            fontSize: '14px',
            margin: 0,
            color: feedback.type === 'success' ? 'var(--status-success)' : 'var(--brand-rot)',
            fontWeight: 500,
          }}>
            {feedback.text}
          </p>
        </div>
      )}
      {!canIssue && (
        <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>
          Operation is cancelled — documents cannot be issued.
        </p>
      )}
    </div>
  );
}

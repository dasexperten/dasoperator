// =============================================================================
// CI — Commercial Invoice. Portrait A4. EN / RU (never BILINGUAL — guarded
// upstream). Seller may be a company or a manufacturer (dei_layer Factory→DEI
// CI leg).
// =============================================================================

import type { ContractRow, DocumentLanguage, LineItemRow } from '../types';
import {
  t, tBilingual, type RenderLanguage,
  Document, Packer, PORTRAIT_PAGE, PORTRAIT_USABLE_DXA, RenderBank, RenderParty,
  RenderSignature, blank, buildDeliveryBankTable, buildMetaRow, buildPartyTable,
  buildProductTable, buildSignature, buildTitle, formatDate, formatMoney,
  pickLineLabel,
  type ProductCell,
} from './shared';

export interface RenderCiInput {
  reference: string;
  issuedAt: number;
  language: DocumentLanguage;
  issuerLanguage?: import('./shared').RenderLanguage;
  partnerLanguage?: import('./shared').RenderLanguage;
  currency: string;
  seller: RenderParty;
  buyer: RenderParty;
  bank: RenderBank;
  signature: RenderSignature;
  contract: ContractRow | null;
  incoterms: string;
  paymentTerms: string | null;
  lineItems: LineItemRow[];
  totalMinor: number;
}

function _resolveTranslator(input: { language: DocumentLanguage; issuerLanguage?: RenderLanguage; partnerLanguage?: RenderLanguage }): {
  primary: RenderLanguage;
  translate: (key: string) => string;
} {
  if (input.language === 'BILINGUAL') {
    const issuer = input.issuerLanguage ?? 'EN';
    const partner = input.partnerLanguage ?? issuer;
    return { primary: issuer, translate: (key) => tBilingual(key, issuer, partner) };
  }
  const lang = input.language as RenderLanguage;
  return { primary: lang, translate: (key) => t(key, lang) };
}


export async function renderCommercialInvoice(input: RenderCiInput): Promise<Uint8Array> {
  const { primary, translate } = _resolveTranslator(input);
  const isRu = primary === 'RU';
  const language: 'EN' | 'RU' = isRu ? 'RU' : 'EN';

  const titleText = translate('title.commercial_invoice');

  // Meta row — labels stay bilingual EN/RU for clarity even on RU-only docs.
  const meta = [
    { label: '№ / No.', value: input.reference },
    { label: 'Date / Дата', value: formatDate(input.issuedAt) },
  ];
  if (input.contract) {
    meta.push({ label: 'Contract / Договор', value: input.contract.contract_no });
  }
  if (input.contract?.unk_reference) {
    meta.push({ label: 'УНК', value: input.contract.unk_reference });
  }

  const partyTable = buildPartyTable({
    language,
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    shipperLabel: translate('party.seller'),
    shipper: input.seller,
    consigneeLabel: translate('party.buyer'),
    consignee: input.buyer,
  });

  const deliveryLines: string[] = [
    `${translate('misc.terms')}: ${input.incoterms}`,
  ];
  if (input.paymentTerms) {
    deliveryLines.push(`${translate('misc.payment')}: ${input.paymentTerms}`);
  }
  const deliveryBankTable = buildDeliveryBankTable({
    language,
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    deliveryHeader: translate('section.delivery'),
    deliveryLines,
    bankHeader: translate('section.bank'),
    bank: input.bank,
  });

  // Product table — 9 cols, sum to 10500 DXA.
  // [#, SKU, Description, HS Code, Origin, Qty, Unit, Unit Price, Total]
  const widths = [350, 800, 3300, 850, 750, 700, 600, 1100, 2050];
  const headers = [
    { text: '#', align: 'center' as const },
    { text: 'SKU', align: 'left' as const },
    { text: translate('col.description'), align: 'left' as const },
    { text: 'HS Code', align: 'center' as const },
    { text: translate('col.origin'), align: 'center' as const },
    { text: translate('col.qty'), align: 'right' as const },
    { text: translate('col.unit'), align: 'center' as const },
    { text: translate('col.unit_price'), align: 'right' as const },
    { text: translate('col.total'), align: 'right' as const },
  ];

  const rows: ProductCell[][] = input.lineItems.map((li, idx) => {
    const desc = pickLineLabel(li, { kind: 'CI', partnerLang: language });
    return [
      { text: String(idx + 1), align: 'center' },
      { text: li.product_id, align: 'left' },
      { text: desc, align: 'left' },
      { text: li.hs_code ?? '', align: 'center' },
      { text: li.country_of_origin ?? '', align: 'center' },
      { text: String(li.qty), align: 'right' },
      { text: translate('col.unit_pcs'), align: 'center' },
      { text: formatMoney(li.unit_price_after_disc, input.currency), align: 'right' },
      { text: formatMoney(li.line_amount, input.currency), align: 'right' },
    ];
  });

  // TOTAL row: merge first 7 cells into the label, leaving the last 2 cols
  // for blank Unit Price + Total Amount.
  const productTable = buildProductTable({
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    widths,
    headers,
    rows,
    totalLabel: translate('total.label'),
    totalLabelSpan: 7,
    totalValues: [
      { text: '', align: 'right' },
      { text: formatMoney(input.totalMinor, input.currency), align: 'right', bold: true },
    ],
  });

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `Commercial Invoice ${input.reference}`,
    sections: [{
      properties: { page: PORTRAIT_PAGE },
      children: [
        buildTitle(titleText),
        buildMetaRow(meta),
        partyTable,
        blank(),
        deliveryBankTable,
        blank(),
        productTable,
        ...buildSignature(input.signature, language),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  renderCommercialInvoicePdf, renderInvoiceSpecBrushesPdf,
  renderInvoiceSpecPastesPdf, renderPackingListPdf, renderTnPdf, renderUpdPdf,
} from '../api/src/skills/invoicer/renderers/pdf';
import { STAMP_SIGNATURE } from '../api/src/skills/invoicer/renderers/stamps';
import type { LineItemRow } from '../api/src/skills/invoicer/types';
import type { RenderParty, RenderSignature } from '../api/src/skills/invoicer/renderers/shared';

const outDir = '/private/tmp/invoicer-pdf-smoke';
mkdirSync(outDir, { recursive: true });

const dei: RenderParty = {
  legalNameEn: 'DAS EXPERTEN INTERNATIONAL LLC', legalNameLocal: null, legalNameCn: null,
  addressEn: 'Sharjah, United Arab Emirates', addressLocal: null, taxId: '2221260.01',
  inn: null, kpp: null, ogrn: null, registrationNo: '2221260.01', email: null,
};
const dee: RenderParty = {
  legalNameEn: 'DAS EXPERTEN EURASIA LLC', legalNameLocal: 'ООО ДАС ЭКСПЕРТЕН ЕВРАЗИЯ', legalNameCn: null,
  addressEn: 'Russian Federation', addressLocal: 'Российская Федерация', taxId: null,
  inn: '0000000000', kpp: '000000000', ogrn: '0000000000000', registrationNo: null, email: null,
};
const dasean: RenderParty = {
  legalNameEn: 'DAS EXPERTEN ASEAN COMPANY LIMITED', legalNameLocal: 'CÔNG TY TNHH DAS EXPERTEN ASEAN', legalNameCn: null,
  addressEn: 'Ho Chi Minh City, Vietnam', addressLocal: 'Thành phố Hồ Chí Minh, Việt Nam', taxId: '0319132917',
  inn: null, kpp: null, ogrn: null, registrationNo: '0319132917', email: null,
};
const honghui: RenderParty = {
  legalNameEn: 'GUANGZHOU HONGHUI DAILY TECHNOLOGY COMPANY LIMITED', legalNameLocal: null, legalNameCn: null,
  addressEn: 'Guangzhou, China', addressLocal: null, taxId: null,
  inn: null, kpp: null, ogrn: null, registrationNo: null, email: null,
};
const jinxia: RenderParty = {
  legalNameEn: 'YANGZHOU JINXIA PLASTIC PRODUCTS CO., LTD.', legalNameLocal: null, legalNameCn: null,
  addressEn: 'Yangzhou, China', addressLocal: null, taxId: null,
  inn: null, kpp: null, ogrn: null, registrationNo: null, email: null,
};

const bank = {
  bankName: 'TEST BANK', bankAddress: 'Test address', accountNumber: '0000000000',
  iban: null, swift: 'TESTBIC0', bik: null, correspondentAccount: null,
  accountHolder: 'TEST ACCOUNT HOLDER', currency: 'USD',
};

const items: LineItemRow[] = [
  {
    id: 'li-1', product_id: 'DE101', item_description: 'Toothpaste', qty: 2400, cartons: 100,
    unit_price: 1.25, unit_price_after_disc: 1.25, line_amount: 3000, currency: 'USD',
    product_manufacturer_id: 'honghui', packaging_manufacturer_id: null,
    description_en: 'Mineral toothpaste', description_ru: 'Минеральная зубная паста', description_cn: '牙膏',
    invoice_label: 'Mineral toothpaste', invoice_label_ru: 'Минеральная зубная паста',
    invoice_label_en: 'Kem đánh răng khoáng chất', invoice_label_cn: '牙膏', hs_code: '3306100000',
    ctn_qty: 24, ctn_weight_gross_kg: 12.4, unit_net_weight_g: 120,
    country_of_origin: 'China', category: 'Toothpaste', subcategory: null,
    vn_registered_name: 'Kem đánh răng khoáng chất', vn_notification_no: 'TEST-001',
  },
  {
    id: 'li-2', product_id: 'DE201', item_description: 'Toothbrush', qty: 1296, cartons: 54,
    unit_price: 0.75, unit_price_after_disc: 0.75, line_amount: 972, currency: 'USD',
    product_manufacturer_id: 'jinxia', packaging_manufacturer_id: null,
    description_en: 'Manual toothbrush', description_ru: 'Зубная щётка', description_cn: '牙刷',
    invoice_label: 'Manual toothbrush', invoice_label_ru: 'Зубная щётка',
    invoice_label_en: 'Bàn chải đánh răng', invoice_label_cn: '牙刷', hs_code: '9603210000',
    ctn_qty: 24, ctn_weight_gross_kg: 8.5, unit_net_weight_g: 38,
    country_of_origin: 'China', category: 'Toothbrush', subcategory: null,
    vn_registered_name: 'Bàn chải đánh răng', vn_notification_no: 'TEST-002',
  },
];

function signature(key: string, name: string, titleEn: string, titleRu: string): RenderSignature {
  const assets = STAMP_SIGNATURE[key];
  if (!assets) throw new Error(`Missing test signature asset ${key}`);
  return {
    name, titleEn, titleRu,
    stamp: { data: assets.stamp.data(), format: assets.stamp.format, width: assets.stamp.width, height: assets.stamp.height },
    handSignature: assets.handSignature
      ? { data: assets.handSignature.data(), format: assets.handSignature.format, width: assets.handSignature.width, height: assets.handSignature.height }
      : null,
    stampIncludesHandSignature: assets.stampIncludesHandSignature,
  };
}

const contract = {
  id: 'contract-test', contract_no: 'TEST-CONTRACT', partner_id: 'test', our_company_id: 'test',
  currency: 'USD', signed_date: null, expiry_date: null, incoterms: 'FOB',
  unk_reference: null, unk_valid_until: null, invoice_language: 'EN' as const,
};
const issuedAt = 1790053200;

const cases: Array<{ name: string; reference: string; render: () => Promise<Uint8Array> }> = [
  { name: '01-dei-ci-en', reference: 'CI-DEI-260001', render: () => renderCommercialInvoicePdf({ reference: 'CI-DEI-260001', issuedAt, language: 'EN', currency: 'USD', seller: dei, buyer: dasean, bank, signature: signature('dei', 'Aram Badalyan', 'General Manager', 'Генеральный директор'), contract, incoterms: 'FOB Nansha', paymentTerms: '100% prepayment', lineItems: items, shipperLine: honghui.legalNameEn, extraCharges: [{ label: 'Freight', amount: 230 }], totalMinor: 4202 }) },
  { name: '02-dei-pl-en', reference: 'PL-DEI-260001', render: () => renderPackingListPdf({ reference: 'PL-DEI-260001', issuedAt, language: 'EN', shipper: dei, consignee: dasean, signature: signature('dei', 'Aram Badalyan', 'General Manager', 'Генеральный директор'), ciReference: 'CI-DEI-260001', lineItems: items }) },
  { name: '03-dee-ci-ru', reference: 'CI-DEE-260002', render: () => renderCommercialInvoicePdf({ reference: 'CI-DEE-260002', issuedAt, language: 'RU', currency: 'RUB', seller: dee, buyer: dee, bank: { ...bank, currency: 'RUB' }, signature: signature('dee', 'Aram Badalyan', 'General Manager', 'Генеральный директор'), contract: { ...contract, currency: 'RUB', invoice_language: 'RU' }, incoterms: 'DAP Москва', paymentTerms: 'Предоплата', lineItems: items, totalMinor: 3972 }) },
  { name: '04-dee-upd-ru', reference: 'UPD-DEE-260003', render: () => renderUpdPdf({ reference: 'UPD-DEE-260003', issuedAt, currency: 'RUB', seller: dee, buyer: dee, signature: signature('dee', 'Aram Badalyan', 'General Manager', 'Генеральный директор'), contract: { ...contract, currency: 'RUB', invoice_language: 'RU' }, lineItems: items, totalMinor: 3972, vatRatePct: 5 }) },
  { name: '05-dee-tn-ru', reference: 'TN-DEE-260004', render: () => renderTnPdf({ reference: 'TN-DEE-260004', issuedAt, shipper: dee, consignee: dee, signature: signature('dee', 'Aram Badalyan', 'General Manager', 'Генеральный директор'), contract, lineItems: items, upcomingUpdRef: 'UPD-DEE-260003' }) },
  { name: '06-honghui-ci-en', reference: 'CI-HHUI-260005', render: () => renderCommercialInvoicePdf({ reference: 'CI-HHUI-260005', issuedAt, language: 'EN', currency: 'USD', seller: honghui, buyer: dei, bank, signature: signature('honghui', 'Ellen Wei', 'Commercial Director', 'Коммерческий директор'), contract, incoterms: 'FOB Nansha', paymentTerms: null, lineItems: items, totalMinor: 3972 }) },
  { name: '07-honghui-pl-en', reference: 'PL-HHUI-260005', render: () => renderPackingListPdf({ reference: 'PL-HHUI-260005', issuedAt, language: 'EN', shipper: honghui, consignee: dei, signature: signature('honghui', 'Ellen Wei', 'Commercial Director', 'Коммерческий директор'), ciReference: 'CI-HHUI-260005', lineItems: items }) },
  { name: '08-honghui-is-v2', reference: 'IS-HHUI-260006', render: () => renderInvoiceSpecPastesPdf({ reference: 'IS-HHUI-260006', issuedAt, currency: 'USD', shipperSeller: honghui, consigneeBuyer: dee, bank, signature: signature('honghui', 'Ellen Wei', 'Commercial Director', 'Коммерческий директор'), contract, incoterms: 'CNF Guangzhou', container: 'TEST0000000', countryStation: 'Russia', lineItems: items, totalMinor: 3972 }) },
  { name: '09-jinxia-is-v1', reference: 'IS-YZJX-260007', render: () => renderInvoiceSpecBrushesPdf({ reference: 'IS-YZJX-260007', issuedAt, currency: 'USD', shipper: jinxia, buyer: dee, seller: jinxia, sellerDistinctFromShipper: false, bank, signature: signature('jinxia', 'Lois Guan', 'Sales Manager', 'Менеджер по продажам'), contract, incoterms: 'FOB Shanghai', consigneeAtTerminal: null, lineItems: [items[1]!], totalMinor: 972 }) },
  { name: '10-dasean-ci-vi', reference: 'CI-DSN-260008', render: () => renderCommercialInvoicePdf({ reference: 'CI-DSN-260008', issuedAt, language: 'VI', currency: 'VND', seller: dasean, buyer: dasean, bank: { ...bank, currency: 'VND' }, signature: signature('dasean', 'Aram Badalyan', 'General Manager', 'Tổng Giám đốc'), contract: { ...contract, currency: 'VND', invoice_language: 'VI' }, incoterms: 'DAP Hồ Chí Minh', paymentTerms: 'Thanh toán trước', lineItems: items, totalMinor: 3972000 }) },
];

const results: Array<Record<string, unknown>> = [];
for (const test of cases) {
  const bytes = await test.render();
  if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error(`${test.name}: invalid PDF header`);
  const loaded = await PDFDocument.load(bytes);
  if (!(loaded.getTitle() ?? '').includes(test.reference)) throw new Error(`${test.name}: reference missing from PDF metadata`);
  if (loaded.getPageCount() < 1) throw new Error(`${test.name}: PDF has no pages`);
  const file = resolve(outDir, `${test.name}.pdf`);
  writeFileSync(file, bytes);
  results.push({ name: test.name, reference: test.reference, bytes: bytes.length, pages: loaded.getPageCount(), file });
}

console.log(JSON.stringify({ success: true, count: results.length, results }, null, 2));

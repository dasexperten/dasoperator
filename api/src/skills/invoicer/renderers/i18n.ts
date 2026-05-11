// =============================================================================
// i18n.ts — document label dictionary for all renderer languages.
//
// Every label that appears on a document (titles, party headers, column
// headers, total labels, signature lines) lives here, keyed by ISO code.
// Renderers call t(key, lang) and get the localized string. If a language
// is not covered, the dictionary falls back to EN.
//
// Adding a new language: add it as a column in each LABELS row. Untranslated
// entries inherit EN. To add a new label: add a row with at minimum EN + RU.
// =============================================================================

export type RenderLanguage =
  | 'EN' | 'RU' | 'KA' | 'ZH' | 'VI' | 'AM' | 'UK'
  | 'DE' | 'TR' | 'UZ' | 'KK' | 'TH' | 'ID' | 'MS'
  | 'HI' | 'AR' | 'FR' | 'ES' | 'PT';

type LabelMap = Partial<Record<RenderLanguage, string>>;

/**
 * Master label dictionary. Keys are stable; values are the human strings.
 * EN is the canonical fallback — every key MUST have an EN value.
 */
const LABELS: Record<string, LabelMap> = {
  // ----- Titles -----
  'title.commercial_invoice': {
    EN: 'COMMERCIAL INVOICE', RU: 'КОММЕРЧЕСКИЙ СЧЁТ-ФАКТУРА',
    KA: 'კომერციული ინვოისი', ZH: '商业发票', VI: 'HÓA ĐƠN THƯƠNG MẠI',
    AM: 'ԱՌԵՎՏՐԱԿԱՆ ՀԱՇԻՎ', UK: 'КОМЕРЦІЙНИЙ ІНВОЙС', DE: 'HANDELSRECHNUNG',
    TR: 'TİCARİ FATURA', UZ: 'TIJORAT HISOB-FAKTURASI', KK: 'КОММЕРЦИЯЛЫҚ ШОТ-ФАКТУРА',
    TH: 'ใบกำกับสินค้า', ID: 'FAKTUR KOMERSIAL', MS: 'INVOIS KOMERSIAL',
    HI: 'वाणिज्यिक चालान', AR: 'فاتورة تجارية', FR: 'FACTURE COMMERCIALE',
    ES: 'FACTURA COMERCIAL', PT: 'FATURA COMERCIAL',
  },
  'title.packing_list': {
    EN: 'PACKING LIST', RU: 'УПАКОВОЧНЫЙ ЛИСТ',
    KA: 'შეფუთვის სია', ZH: '装箱单', VI: 'PHIẾU ĐÓNG GÓI',
    AM: 'ՓԱԹԵԹԱՎՈՐՄԱՆ ՑՈՒՑԱԿ', UK: 'ПАКУВАЛЬНИЙ ЛИСТ', DE: 'PACKLISTE',
    TR: 'ÇEKİ LİSTESİ', UZ: 'QADOQLASH RO‘YXATI', KK: 'ОРАУ ТІЗІМІ',
    TH: 'รายการบรรจุภัณฑ์', ID: 'DAFTAR KEMASAN', MS: 'SENARAI PEMBUNGKUSAN',
    HI: 'पैकिंग सूची', AR: 'قائمة التعبئة', FR: 'LISTE DE COLISAGE',
    ES: 'LISTA DE EMBALAJE', PT: 'LISTA DE EMBALAGEM',
  },
  'title.invoice_specification': {
    EN: 'INVOICE & SPECIFICATION', RU: 'СЧЁТ И СПЕЦИФИКАЦИЯ',
    KA: 'ინვოისი და სპეციფიკაცია', ZH: '发票与规格', VI: 'HÓA ĐƠN VÀ ĐẶC ĐIỂM KỸ THUẬT',
  },

  // ----- Party headers -----
  'party.seller': {
    EN: 'SELLER', RU: 'ПРОДАВЕЦ', KA: 'გამყიდველი', ZH: '卖方', VI: 'NGƯỜI BÁN',
    AM: 'ՎԱՃԱՌՈՂ', UK: 'ПРОДАВЕЦЬ', DE: 'VERKÄUFER', TR: 'SATICI',
    UZ: 'SOTUVCHI', KK: 'САТУШЫ', TH: 'ผู้ขาย', ID: 'PENJUAL', MS: 'PENJUAL',
    HI: 'विक्रेता', AR: 'البائع', FR: 'VENDEUR', ES: 'VENDEDOR', PT: 'VENDEDOR',
  },
  'party.buyer': {
    EN: 'BUYER', RU: 'ПОКУПАТЕЛЬ', KA: 'მყიდველი', ZH: '买方', VI: 'NGƯỜI MUA',
    AM: 'ԳՆՈՐԴ', UK: 'ПОКУПЕЦЬ', DE: 'KÄUFER', TR: 'ALICI',
    UZ: 'XARIDOR', KK: 'САТЫП АЛУШЫ', TH: 'ผู้ซื้อ', ID: 'PEMBELI', MS: 'PEMBELI',
    HI: 'क्रेता', AR: 'المشتري', FR: 'ACHETEUR', ES: 'COMPRADOR', PT: 'COMPRADOR',
  },
  'party.shipper': {
    EN: 'SHIPPER', RU: 'ОТПРАВИТЕЛЬ', KA: 'გამგზავნი', ZH: '发货人', VI: 'NGƯỜI GỬI HÀNG',
    AM: 'ՈՒՂԱՐԿՈՂ', UK: 'ВІДПРАВНИК', DE: 'ABSENDER', TR: 'GÖNDERİCİ',
  },
  'party.consignee': {
    EN: 'CONSIGNEE', RU: 'ПОЛУЧАТЕЛЬ', KA: 'მიმღები', ZH: '收货人', VI: 'NGƯỜI NHẬN HÀNG',
    AM: 'ՍՏԱՑՈՂ', UK: 'ОДЕРЖУВАЧ', DE: 'EMPFÄNGER', TR: 'ALICI',
  },

  // ----- Meta fields -----
  'meta.number_short': {
    EN: '№ / No.', RU: '№ / No.', KA: '№', ZH: '编号', VI: 'Số',
    AM: 'Համար', UK: '№', DE: 'Nr.', TR: 'No.',
  },
  'meta.date': {
    EN: 'Date', RU: 'Дата', KA: 'თარიღი', ZH: '日期', VI: 'Ngày',
    AM: 'Ամսաթիվ', UK: 'Дата', DE: 'Datum', TR: 'Tarih',
    UZ: 'Sana', KK: 'Күні', TH: 'วันที่', ID: 'Tanggal', MS: 'Tarikh',
    HI: 'दिनांक', AR: 'التاريخ', FR: 'Date', ES: 'Fecha', PT: 'Data',
  },
  'meta.related_ci': {
    EN: 'Related CI', RU: 'Связанный СФ', KA: 'დაკავშირებული ინვოისი',
    ZH: '相关发票', VI: 'HĐ liên quan', DE: 'Zugehörige Rechnung',
  },

  // ----- Section headers -----
  'section.delivery': {
    EN: 'DELIVERY', RU: 'УСЛОВИЯ ПОСТАВКИ', KA: 'მიწოდების პირობები',
    ZH: '交货条款', VI: 'ĐIỀU KHOẢN GIAO HÀNG', DE: 'LIEFERBEDINGUNGEN',
  },
  'section.bank': {
    EN: 'BANK DETAILS', RU: 'БАНКОВСКИЕ РЕКВИЗИТЫ', KA: 'საბანკო რეკვიზიტები',
    ZH: '银行账户信息', VI: 'CHI TIẾT NGÂN HÀNG', DE: 'BANKVERBINDUNG',
  },
  'section.shipment': {
    EN: 'SHIPMENT', RU: 'ОТГРУЗКА', KA: 'გადაზიდვა', ZH: '装运', VI: 'LÔ HÀNG',
  },
  'section.summary': {
    EN: 'SUMMARY', RU: 'ИТОГИ', KA: 'შემაჯამებელი', ZH: '汇总', VI: 'TỔNG KẾT',
  },

  // ----- Table columns -----
  'col.description': {
    EN: 'Description', RU: 'Описание', KA: 'აღწერა', ZH: '描述', VI: 'Mô tả',
    AM: 'Նկարագրություն', UK: 'Опис', DE: 'Beschreibung', TR: 'Açıklama',
  },
  'col.origin': {
    EN: 'Origin', RU: 'Страна', KA: 'წარმოშობა', ZH: '原产地', VI: 'Xuất xứ',
    DE: 'Ursprung', TR: 'Menşei',
  },
  'col.qty': {
    EN: 'Qty', RU: 'Кол-во', KA: 'რაოდენობა', ZH: '数量', VI: 'Số lượng',
    DE: 'Menge', TR: 'Adet',
  },
  'col.qty_total': {
    EN: 'Total Qty', RU: 'Кол-во', KA: 'სულ რაოდენობა', ZH: '总数量', VI: 'Tổng số lượng',
  },
  'col.qty_per_ctn': {
    EN: 'Qty/CTN', RU: 'Шт./кор.', KA: 'რაოდენობა/ყუთი', ZH: '每箱数量', VI: 'SL/Thùng',
  },
  'col.unit': {
    EN: 'Unit', RU: 'Ед.', KA: 'ერთეული', ZH: '单位', VI: 'Đơn vị',
  },
  'col.unit_pcs': {
    EN: 'pcs', RU: 'шт.', KA: 'ცალი', ZH: '件', VI: 'cái',
    DE: 'Stk.', TR: 'adet', FR: 'pcs', ES: 'uds.', PT: 'pçs',
  },
  'col.unit_price': {
    EN: 'Unit Price', RU: 'Цена', KA: 'ერთეულის ფასი', ZH: '单价', VI: 'Đơn giá',
    DE: 'Stückpreis', TR: 'Birim Fiyat',
  },
  'col.total': {
    EN: 'Total', RU: 'Сумма', KA: 'სულ', ZH: '合计', VI: 'Tổng cộng',
    DE: 'Gesamt', TR: 'Toplam', FR: 'Total', ES: 'Total', PT: 'Total',
  },
  'col.cartons': {
    EN: 'Cartons', RU: 'Кор-ов', KA: 'ყუთები', ZH: '箱数', VI: 'Số thùng',
  },
  'col.net_kg': {
    EN: 'Net (kg)', RU: 'Нетто, кг', KA: 'წონა ნეტო, კგ', ZH: '净重(公斤)', VI: 'Trọng lượng tịnh (kg)',
  },
  'col.gross_kg': {
    EN: 'Gross (kg)', RU: 'Брутто, кг', KA: 'წონა ბრუტო, კგ', ZH: '毛重(公斤)', VI: 'Trọng lượng tổng (kg)',
  },

  // ----- Totals row -----
  'total.label': {
    EN: 'TOTAL', RU: 'ИТОГО', KA: 'სულ', ZH: '合计', VI: 'TỔNG CỘNG',
    AM: 'ԸՆԴԱՄԵՆԸ', UK: 'РАЗОМ', DE: 'GESAMT', TR: 'TOPLAM',
    FR: 'TOTAL', ES: 'TOTAL', PT: 'TOTAL',
  },

  // ----- Summary block lines -----
  'summary.cartons': {
    EN: 'Cartons', RU: 'Мест', KA: 'ყუთები', ZH: '总箱数', VI: 'Tổng số thùng',
  },
  'summary.qty': {
    EN: 'Total qty', RU: 'Штук', KA: 'სულ რაოდენობა', ZH: '总件数', VI: 'Tổng số lượng',
  },
  'summary.net': {
    EN: 'Net (kg)', RU: 'Нетто, кг', KA: 'ნეტო, კგ', ZH: '净重(公斤)',
  },
  'summary.gross': {
    EN: 'Gross (kg)', RU: 'Брутто, кг', KA: 'ბრუტო, კგ', ZH: '毛重(公斤)',
  },
  'summary.weights_tbd': {
    EN: 'Weights', RU: 'Веса', KA: 'წონები', ZH: '重量',
  },
  'summary.for_invoice': {
    EN: 'For invoice', RU: 'К инвойсу', KA: 'ინვოისისთვის', ZH: '相关发票号',
  },

  // ----- Other -----
  'misc.terms': {
    EN: 'Terms', RU: 'Условия', KA: 'პირობები', ZH: '条款', VI: 'Điều khoản',
  },
  'misc.payment': {
    EN: 'Payment', RU: 'Оплата', KA: 'გადახდა', ZH: '付款', VI: 'Thanh toán',
  },
  'sig.shipper': {
    EN: 'Shipper signature', RU: 'Подпись отправителя',
    KA: 'გამგზავნის ხელმოწერა', ZH: '发货人签字',
  },
  'sig.seller': {
    EN: 'Seller signature', RU: 'Подпись продавца',
    KA: 'გამყიდველის ხელმოწერა', ZH: '卖方签字',
  },
};

/**
 * Translate a label key to the given language. Falls back to EN if the
 * language is not covered for this key.
 */
export function t(key: string, lang: RenderLanguage): string {
  const entry = LABELS[key];
  if (!entry) {
    // Hard signal: missing label key. Don't ship a silent stringification.
    return `[?${key}]`;
  }
  return entry[lang] ?? entry.EN ?? `[?${key}]`;
}

/**
 * Combine an issuer-language label with its partner-language counterpart
 * for BILINGUAL rendering. Format: "EN / RU" (issuer first).
 */
export function tBilingual(key: string, issuerLang: RenderLanguage, partnerLang: RenderLanguage): string {
  if (issuerLang === partnerLang) return t(key, issuerLang);
  const primary = t(key, issuerLang);
  const secondary = t(key, partnerLang);
  if (primary === secondary) return primary;
  return `${primary} / ${secondary}`;
}

/**
 * Some languages have no specific translation for some keys. This returns
 * true if we have a real translation (not an EN fallback).
 */
export function hasTranslation(key: string, lang: RenderLanguage): boolean {
  const entry = LABELS[key];
  if (!entry) return false;
  return entry[lang] !== undefined;
}

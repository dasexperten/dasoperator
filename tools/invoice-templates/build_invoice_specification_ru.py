"""
INVOICE-SPECIFICATION / Счёт-Спецификация (Russian customs format, portrait A4).
Three roles: Shipper (factory) / Seller (factory or DEI) / Buyer (DEE).
Mirrors the approved Das Experten sample: station consignee header, contract line,
terms of delivery, country of origin + HS code columns, EN+RU bilingual descriptions,
net/gross weights, per-pcs price, amount. Signature/stamp follow whoever is Seller.
"""
import json, os, subprocess, datetime as dt
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    Image as RLImage,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as canvas_mod
from pypdf import PdfReader
from PIL import Image as PILImage

CF_ACCOUNT = os.environ["CF_ACCOUNT_ID"]
CF_DB = os.environ["CF_D1_DATABASE_ID"]
CF_TOKEN = os.environ["CF_API_TOKEN"]

def d1(sql):
    r = subprocess.run(["curl","-s","-X","POST",
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/d1/database/{CF_DB}/query",
        "-H",f"Authorization: Bearer {CF_TOKEN}","-H","Content-Type: application/json",
        "-d",json.dumps({"sql":sql})], capture_output=True, text=True)
    return json.loads(r.stdout)["result"][0]["results"]

# Fonts — DejaVu carries Cyrillic + Latin; bold variant too
pdfmetrics.registerFont(TTFont("DV", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DV-B", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
RU, RU_B = "DV", "DV-B"

INK = colors.HexColor("#1a1a1a"); MUTED = colors.HexColor("#555555")
BLUE = colors.HexColor("#3a4a78"); LINE = colors.HexColor("#999999")
LIGHT = colors.HexColor("#cccccc"); BAND = colors.HexColor("#f2f2f0")
BLACK_BAR = colors.HexColor("#1a1a1a"); WHITE = colors.white

def st(name, font=RU, size=7, leading=8.5, color=INK, align=TA_LEFT, **kw):
    return ParagraphStyle(name=name, fontName=font, fontSize=size, leading=leading,
                          textColor=color, alignment=align, **kw)

# Fixed station consignee (constant per Aram)
CONSIGNEE_STATION = (
    "Получатель по ст. — ООО СТС-ЛОГИСТИКА, 143345, Московская область, Наро-Фоминск, "
    "рп Селятино, Вокзальная стр.2А комн.52, ИНН 5030091396, КПП 503001001, "
    "ОГРН 1175074009351, ОКПО 16111351, ТГНЛ 7040, тел: 495-7834402<br/>"
    "<font color='#888888'>LLC STS-LOGISTICS, 143345, Moscow region, Naro-Fominsk city, "
    "working settlement Selyatino, Vokzalnaya street, building 2A, room 52</font>"
)

# Party blocks
SHIPPERS = {
    "jinxia": {
        "en": "YANGZHOU JINXIA PLASTIC PRODUCTS & RUBBER CO., LTD<br/>"
              "ADD: NO.40 WEIYE ROAD HANGJI INDUSTRIAL PARK YANGZHOU CITY CHINA<br/>TEL: 86+0514-87271306",
        "ru": "Компания с ограниченной ответственностью Янчжоу Цзинься Пластик Продактс энд Раббер<br/>"
              "Китай, Янчжоу, Ханцзи Индастриал Парк, ул. Вэйе 40<br/>Тел.: 86+0514-87271306",
        "fob": "FOB Shanghai",
        "stamp": "assets/jinxia_stamp.png", "stamp_box": (30, 30),
        "sig": "assets/lois_guan_signature.png",
        "signatory_en": "Lois Guan", "signatory_title": "Sales Manager / Менеджер по продажам",
    },
    "honghui": {
        "en": "GUANGZHOU HONGHUI DAILY TECHNOLOGY COMPANY LIMITED<br/>Guangzhou, Guangdong Province, China",
        "ru": "Гуанчжоу Хунхуэй Дейли Текнолоджи Компани Лимитед<br/>Китай, провинция Гуандун, Гуанчжоу",
        "fob": "FOB Guangzhou",
        "stamp": "assets/honghui_stamp.png", "stamp_box": (38, 28),
        "sig": "assets/ellen_wei_signature.png",
        "signatory_en": "Ellen Wei", "signatory_title": "Commercial Director / Коммерческий директор",
    },
}

# Seller can be the factory itself or DEI
SELLERS_RU = {
    "jinxia": {
        "en": "YANGZHOU JINXIA PLASTIC PRODUCTS & RUBBER CO., LTD<br/>"
              "NO.40 WEIYE ROAD HANGJI INDUSTRIAL PARK YANGZHOU CITY CHINA",
        "ru": "Компания с ограниченной ответственностью Янчжоу Цзинься Пластик Продактс энд Раббер<br/>"
              "Китай, Янчжоу, Ханцзи Индастриал Парк, ул. Вэйе 40",
    },
    "honghui": {
        "en": "GUANGZHOU HONGHUI DAILY TECHNOLOGY COMPANY LIMITED<br/>Guangzhou, Guangdong Province, China",
        "ru": "Гуанчжоу Хунхуэй Дейли Текнолоджи Компани Лимитед<br/>Китай, провинция Гуандун, Гуанчжоу",
    },
    "dei": {
        "en": "DAS EXPERTEN INTERNATIONAL LLC<br/>Sharjah Media City Free Zone, Al Messaned, Sharjah, UAE<br/>Registration No: 2221260",
        "ru": "ООО «ДАС ЭКСПЕРТЕН ИНТЕРНЭШНЛ»<br/>Свободная зона Sharjah Media City, Аль-Мессанед, Шарджа, ОАЭ<br/>Регистрационный номер: 2221260",
    },
}

BUYER_DEE = {
    "en": "DAS EXPERTEN EURASIA LLC<br/>REPUBLIC OF MORDOVIA, SARANSK STREET 1-I INDUSTRIAL, "
          "BUILDING 23, OFFICE 4, RUSSIAN FEDERATION<br/>INN 9704117379",
    "ru": "ООО «ДАС ЭКСПЕРТЕН ЕВРАЗИЯ»<br/>Россия, РФ, Республика Мордовия, Саранск, "
          "улица 1-я Промышленная, дом 23, офис 4<br/>ИНН 9704117379",
}

# RU translation of product description
import re
def clean_ru(en):
    s = en
    s = s.replace("interdental brushes", "межзубные ёршики").replace("toothbrush", "зубная щётка")
    s = s.replace("dental floss", "зубная нить").replace("Dental Floss", "зубная нить")
    s = s.replace("Small size", "Размер S").replace("Medium size", "Размер M").replace("Large size", "Размер L")
    s = re.sub(r"(\d+)pcs\.", r"\1 шт.", s)
    s = re.sub(r"(\d+)pc\.", r"\1 шт.", s)
    return s

def fit_image(path, max_w_mm, max_h_mm):
    with PILImage.open(path) as pim:
        sw, sh = pim.size
    a = sw / sh
    w = max_w_mm; h = w / a
    if h > max_h_mm:
        h = max_h_mm; w = h * a
    return RLImage(path, width=w*mm, height=h*mm)

HS_FALLBACK = {"de125": "9603300000", "de126": "9603300000"}  # interdental brushes

def build(op_id, output_path, seller_override=None):
    op = d1(f"SELECT * FROM operations WHERE id='{op_id}'")[0]
    lines = d1(
        "SELECT p.id AS sku, p.invoice_label_en, p.hs_code, p.country_of_origin, "
        "p.unit_net_weight_g, p.ctn_weight_gross_kg, li.qty, li.cartons, li.unit_price, li.line_amount "
        f"FROM line_items li LEFT JOIN products p ON p.id=li.product_id WHERE li.operation_id='{op_id}' "
        "ORDER BY COALESCE(p.hs_code,'zzz'), p.id"
    )

    shipper_id = op.get("manufacturer_id") or "jinxia"
    shipper = SHIPPERS[shipper_id]
    # Seller defaults to the factory unless overridden (e.g. 'dei')
    seller_id = seller_override or op.get("legal_seller_id") or shipper_id
    seller = SELLERS_RU[seller_id]

    contract = op.get("contract_id") or "—"
    op_date = dt.datetime.fromtimestamp(op["operation_date"], tz=dt.timezone.utc).strftime("%d.%m.%Y")
    invoice_no = op["reference"]
    fob = shipper["fob"]

    # Currency: this RU spec is USD-style per sample, but use the operation's currency
    ccy_sym = {"USD": "USD", "CNY": "CNY", "EUR": "EUR"}.get(op["currency"], op["currency"])

    # signature/stamp belong to Seller
    if seller_id == "dei":
        stamp_path = "assets/dei_stamp_pure.png"
        sig_path = "assets/aram_badalyan_signature.png"  # awaiting upload
        signatory = "Aram Badalyan"
        signatory_title = "General Manager / Генеральный директор"
        stamp_box = (34, 34)
    else:
        stamp_path = shipper["stamp"]; sig_path = shipper["sig"]
        signatory = shipper["signatory_en"]; signatory_title = shipper["signatory_title"]
        stamp_box = shipper["stamp_box"]

    PAGE_W = A4[0] - 20*mm  # margins 10 each side

    # ---- styles ----
    S_DOCTITLE = st("dt", RU_B, 13, 15, align=TA_LEFT)
    S_HDR_L = st("hl", RU_B, 7, 9)
    S_HDR_V = st("hv", RU_B, 7.5, 9)
    S_SMALL = st("sm", RU, 6.5, 8, color=MUTED)
    S_SMALL_RU = st("smru", RU, 6.5, 8, color=BLUE)
    S_ROLE = st("role", RU_B, 6.5, 8)
    S_PARTY_EN = st("pen", RU_B, 6.8, 8.4)
    S_PARTY_RU = st("pru", RU, 6.5, 8, color=BLUE)
    S_TH = st("th", RU_B, 6, 7.5, color=WHITE, align=TA_CENTER)
    S_TD = st("td", RU, 6.2, 7.6, align=TA_CENTER)
    S_TD_DESC_EN = st("tde", RU, 6.2, 7.6)
    S_TD_DESC_RU = st("tdr", RU, 5.8, 7, color=BLUE)
    S_TD_R = st("tdr2", RU_B, 6.2, 7.6, align=TA_RIGHT)
    S_TD_NUM = st("tdnum", RU, 6, 7, align=TA_RIGHT)  # non-bold compact for weight/qty/pkg cols
    S_TOT = st("tot", RU_B, 6.8, 8.5, align=TA_CENTER)
    S_TOT_R = st("totr", RU_B, 7, 8.5, align=TA_RIGHT)
    S_SIG_T = st("sigt", RU_B, 7.5, 10, align=TA_RIGHT)

    doc = BaseDocTemplate(output_path, pagesize=A4,
                          leftMargin=10*mm, rightMargin=10*mm, topMargin=8*mm, bottomMargin=10*mm,
                          title=f"Invoice-Specification {invoice_no}", author=seller_id.upper())
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="m",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=lambda c,d: _footer(c,d,seller_id))])
    story = []

    # ===== Title =====
    story.append(Paragraph("INVOICE-SPECIFICATION / Счёт-Спецификация", S_DOCTITLE))
    story.append(Spacer(1, 2*mm))

    # ===== Contract / No / Date line =====
    meta = Table([[
        Paragraph(f"<b>Договор №:</b> {contract} from 01.01.2025", S_HDR_V),
        Paragraph(f"<b>№:</b> {invoice_no.replace('JINX-','').replace('HHUI-','')}", S_HDR_V),
        Paragraph(f"<b>Date / Дата:</b> {op_date}", S_HDR_V),
    ]], colWidths=[PAGE_W*0.5, PAGE_W*0.2, PAGE_W*0.3])
    meta.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("BOTTOMPADDING",(0,0),(-1,-1),3),("TOPPADDING",(0,0),(-1,-1),0)]))
    story.append(meta)

    # ===== Station consignee band =====
    cons = Table([[Paragraph(CONSIGNEE_STATION, S_SMALL_RU)]], colWidths=[PAGE_W])
    cons.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),2),("BOTTOMPADDING",(0,0),(-1,-1),3),
        ("LINEBELOW",(0,0),(-1,-1),0.5,LINE)]))
    story.append(cons)
    story.append(Spacer(1, 2*mm))

    # ===== Parties grid: left = Shipper + Seller stacked; right = Buyer =====
    def party_cell(role, en, ru):
        return Table([[Paragraph(role, S_ROLE)],
                      [Paragraph(en, S_PARTY_EN)],
                      [Paragraph(ru, S_PARTY_RU)]], colWidths=[PAGE_W*0.6])

    left = Table([
        [Paragraph("Отправитель / Shipper", S_ROLE)],
        [Paragraph(shipper["en"], S_PARTY_EN)],
        [Paragraph(shipper["ru"], S_PARTY_RU)],
        [Spacer(1, 2)],
        [Paragraph("Продавец / Seller", S_ROLE)],
        [Paragraph(seller["en"], S_PARTY_EN)],
        [Paragraph(seller["ru"], S_PARTY_RU)],
    ], colWidths=[PAGE_W*0.62])
    left.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),1),("BOTTOMPADDING",(0,0),(-1,-1),1)]))

    right = Table([
        [Paragraph("Покупатель / Buyer", S_ROLE)],
        [Paragraph(BUYER_DEE["en"], S_PARTY_EN)],
        [Paragraph(BUYER_DEE["ru"], S_PARTY_RU)],
    ], colWidths=[PAGE_W*0.36])
    right.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),1),("BOTTOMPADDING",(0,0),(-1,-1),1)]))

    parties = Table([[left, right]], colWidths=[PAGE_W*0.63, PAGE_W*0.37])
    parties.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),
        ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4)]))
    story.append(parties)
    story.append(Spacer(1, 2*mm))

    # ===== Terms of delivery / destination band =====
    terms = Table([
        [Paragraph("<b>Terms of delivery / Условия поставки:</b>", S_SMALL),
         Paragraph(fob, S_HDR_V),
         Paragraph("<b>Страна назначения / Destination:</b>", S_SMALL),
         Paragraph("РФ / RF", S_HDR_V)],
        [Paragraph("<b>Container / Контейнер:</b>", S_SMALL),
         Paragraph("—", S_SMALL),
         Paragraph("<b>Станция назначения / Station:</b>", S_SMALL),
         Paragraph("Селятино / Selyatino", S_HDR_V)],
    ], colWidths=[PAGE_W*0.28, PAGE_W*0.22, PAGE_W*0.28, PAGE_W*0.22])
    terms.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),4),
        ("TOPPADDING",(0,0),(-1,-1),1),("BOTTOMPADDING",(0,0),(-1,-1),1),
        ("LINEBELOW",(0,-1),(-1,-1),0.5,LINE),("LINEABOVE",(0,0),(-1,0),0.5,LINE)]))
    story.append(terms)
    story.append(Spacer(1, 2*mm))

    # ===== Line-items table =====
    header = [
        Paragraph("No.", S_TH),
        Paragraph("HS Code /<br/>Код ТН ВЭД", S_TH),
        Paragraph("Страна<br/>происх. /<br/>Origin", S_TH),
        Paragraph("Описание товаров / Description of goods", S_TH),
        Paragraph("Кол-во<br/>штук /<br/>Qty pcs", S_TH),
        Paragraph("Мест,<br/>коробок /<br/>Pkgs", S_TH),
        Paragraph("Вес нетто<br/>кг / Net<br/>wt kg", S_TH),
        Paragraph("Вес брутто<br/>кг / Gross<br/>wt kg", S_TH),
        Paragraph(f"Цена /<br/>Price<br/>{ccy_sym}", S_TH),
        Paragraph(f"Сумма /<br/>Amount<br/>{ccy_sym}", S_TH),
    ]

    body = [header]
    t_qty = t_pkg = 0
    t_nw = t_gw = t_amt = 0.0
    group_no = 0
    last_hs = None
    for r in lines:
        sku = (r["sku"] or "").lower()
        hs = r["hs_code"] or HS_FALLBACK.get(sku, "—")
        if hs != last_hs:
            group_no += 1
            last_hs = hs
        country = r["country_of_origin"] or "China"
        if country == "China":
            country_disp = "China/<font color='#3a4a78'>Китай</font>"
        else:
            country_disp = country
        S_TD_ORIGIN = st("tdo", RU, 6.2, 7.6, align=TA_CENTER, splitLongWords=False)
        en = r["invoice_label_en"] or sku.upper()
        ru = clean_ru(en)
        qty = r["qty"] or 0
        pkg = r["cartons"] or 0
        nw = (r["unit_net_weight_g"] or 0) / 1000.0 * qty
        gw = (r["ctn_weight_gross_kg"] or 0) * pkg
        price = r["unit_price"] or 0
        amt = r["line_amount"] or 0
        t_qty += qty; t_pkg += pkg; t_nw += nw; t_gw += gw; t_amt += amt

        desc = Table([[Paragraph(en, S_TD_DESC_EN)], [Paragraph(ru, S_TD_DESC_RU)]],
                     colWidths=[PAGE_W*0.2803 - 4])
        desc.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
            ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0)]))

        body.append([
            Paragraph(str(group_no), S_TD),
            Paragraph(hs, S_TD),
            Paragraph(country_disp, S_TD_ORIGIN),
            desc,
            Paragraph(f"{qty:,}".replace(","," "), S_TD_NUM),
            Paragraph(f"{pkg}", S_TD_NUM),
            Paragraph(f"{nw:,.2f}", S_TD_NUM),
            Paragraph(f"{gw:,.2f}", S_TD_NUM),
            Paragraph(f"{price:.4f}".rstrip('0').rstrip('.') if price < 1 else f"{price:.2f}", S_TD_R),
            Paragraph(f"{amt:,.2f}", S_TD_R),
        ])

    # totals row
    body.append([
        Paragraph("Total / Итого", S_TOT), "", "", "",
        Paragraph(f"{t_qty:,}".replace(","," "), S_TOT_R),
        Paragraph(f"{t_pkg}", S_TOT_R),
        Paragraph(f"{t_nw:,.1f}", S_TOT_R),
        Paragraph(f"{t_gw:,.1f}", S_TOT_R),
        "",
        Paragraph(f"{t_amt:,.2f}", S_TOT_R),
    ])

    col_w = [
        PAGE_W*0.033, PAGE_W*0.0857, PAGE_W*0.0967, PAGE_W*0.2803,
        PAGE_W*0.0824, PAGE_W*0.0604, PAGE_W*0.0934, PAGE_W*0.0934,
        PAGE_W*0.0659, PAGE_W*0.1088,
    ]
    tbl = Table(body, colWidths=col_w, repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND",(0,0),(-1,0),BLACK_BAR),("VALIGN",(0,0),(-1,0),"MIDDLE"),
        ("TOPPADDING",(0,0),(-1,0),3),("BOTTOMPADDING",(0,0),(-1,0),3),
        ("VALIGN",(0,1),(-1,-2),"MIDDLE"),
        ("TOPPADDING",(0,1),(-1,-2),2),("BOTTOMPADDING",(0,1),(-1,-2),2),
        ("LEFTPADDING",(0,0),(-1,-1),2),("RIGHTPADDING",(0,0),(-1,-1),2),
        ("GRID",(0,0),(-1,-2),0.4,LIGHT),
        ("BOX",(0,0),(-1,-1),0.6,INK),
        # totals
        ("BACKGROUND",(0,-1),(-1,-1),BAND),("SPAN",(0,-1),(3,-1)),
        ("VALIGN",(0,-1),(-1,-1),"MIDDLE"),("TOPPADDING",(0,-1),(-1,-1),3),("BOTTOMPADDING",(0,-1),(-1,-1),3),
        ("LINEABOVE",(0,-1),(-1,-1),0.8,INK),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 6*mm))

    # ===== Signature block =====
    sig_title = Table([
        [Paragraph(signatory_title, S_SIG_T)],
        [Paragraph(signatory, S_SIG_T)],
    ], colWidths=[PAGE_W*0.5])
    sig_title.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),1),
        ("ALIGN",(0,0),(-1,-1),"RIGHT")]))

    combo = "assets/dei_stamp_signature.png"
    if seller_id == "dei" and os.path.exists(combo):
        visual = fit_image(combo, 72.0, 51.9)
    else:
        stamp_img = fit_image(stamp_path, stamp_box[0], stamp_box[1]) if os.path.exists(stamp_path) else Paragraph("", S_SIG_T)
        sig_img = fit_image(sig_path, 42, 14) if os.path.exists(sig_path) else Paragraph("", S_SIG_T)
        visual = Table([[sig_img, stamp_img]], colWidths=[46*mm, (stamp_box[0]+6)*mm])
        visual.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"MIDDLE"),
            ("ALIGN",(0,0),(0,0),"CENTER"),("ALIGN",(1,0),(1,0),"CENTER"),
            ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0)]))

    # Right-align the whole signature block: place it in the right cell of a 2-col table
    sig_inner = Table([[sig_title], [visual]], colWidths=[PAGE_W*0.5])
    sig_inner.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("ALIGN",(0,0),(-1,-1),"RIGHT")]))
    sig_block = Table([["", sig_inner]], colWidths=[PAGE_W*0.5, PAGE_W*0.5])
    sig_block.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("VALIGN",(0,0),(-1,-1),"TOP"),("ALIGN",(1,0),(1,0),"RIGHT")]))
    story.append(sig_block)

    doc.build(story)
    return output_path

def _footer(canv, doc, seller_id):
    canv.saveState()
    w, h = A4
    canv.setStrokeColor(LIGHT); canv.setLineWidth(0.4)
    canv.line(10*mm, 8*mm, w-10*mm, 8*mm)
    canv.setFillColor(MUTED); canv.setFont(RU, 6)
    canv.drawString(10*mm, 5*mm, "INVOICE-SPECIFICATION / Счёт-Спецификация")
    canv.drawRightString(w-10*mm, 5*mm, f"Стр. {canv.getPageNumber()}")
    canv.restoreState()

if __name__ == "__main__":
    out = "/mnt/user-data/outputs/JINX-26052101_invoice_spec_RU.pdf"
    build("op_7787847d-c497-4f38-bb98-5710367f6297", out)
    pages = len(PdfReader(out).pages)
    print(f"OK: {out} ({os.path.getsize(out):,} bytes, {pages} page(s))")

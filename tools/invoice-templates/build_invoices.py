"""
Generic Commercial Invoice + Specification PDF generator.

Features:
  - Pulls operation, partner, company, and line-item data from D1
  - Per-partner seller profile (stamp, signature, signatory name/title)
  - Multi-currency support (CNY / USD / EUR)
  - HARD RULE: iterative autofit-to-single-page. If content overflows by a
    small margin, the renderer progressively tightens paddings, spacers,
    and (last resort) font sizes until it lands on a single page.
"""

import json
import os
import subprocess
import datetime as dt
from num2words import num2words

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate,
    Paragraph, Spacer, Table, TableStyle, Image as RLImage,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as canvas_mod
from pypdf import PdfReader

# ===== D1 access =====
CF_ACCOUNT = os.environ["CF_ACCOUNT_ID"]
CF_DB = os.environ["CF_D1_DATABASE_ID"]
CF_TOKEN = os.environ["CF_API_TOKEN"]


def d1(sql):
    r = subprocess.run(
        ["curl", "-s", "-X", "POST",
         f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/d1/database/{CF_DB}/query",
         "-H", f"Authorization: Bearer {CF_TOKEN}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"sql": sql})],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(r.stdout)
    if not data.get("success"):
        raise RuntimeError(f"D1 query failed: {data}")
    return data["result"][0]["results"]


# ===== Fonts =====
pdfmetrics.registerFont(TTFont("CJK", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", subfontIndex=0))
BASE = "Helvetica"
BASE_B = "Helvetica-Bold"
CJK = "CJK"

# ===== Colors =====
INK = colors.HexColor("#1a1a1a")
MUTED = colors.HexColor("#666666")
LINE = colors.HexColor("#cccccc")
BAND = colors.HexColor("#f5f5f3")
BLACK_BAR = colors.HexColor("#1a1a1a")
WHITE = colors.white

# ===== Compression schedule for autofit =====
# Each step progressively tightens the layout. Index 0 = roomy default.
# Increasing index = tighter = more chance of single-page fit.
COMPRESSION = [
    # name      bodyfont row_pad  meta_pad  aiw_pad  spacer_mm  margin_mm
    ("level0",  8.5,     3,       6,        5,       4,         16),
    ("level1",  8.5,     2,       5,        4,       3,         14),
    ("level2",  8.0,     2,       4,        3,       2.5,       14),
    ("level3",  7.5,     1.5,     3,        3,       2,         12),
    ("level4",  7.0,     1,       3,        2,       1.5,       10),
]


# ===== Seller profiles =====
# stamp_path / signature_path: assets on disk relative to /home/claude
# When assets aren't available yet, the generator raises a clear error.
SELLERS = {
    "jinxia": {
        "name_en": "YANGZHOU JINXIA PLASTIC PRODUCTS AND RUBBER CO., LTD.",
        "name_en_2line": "YANGZHOU JINXIA PLASTIC PRODUCTS<br/>AND RUBBER CO., LTD.",
        "name_cn": "扬州金霞塑料制品橡胶有限公司",
        "address": "No.1 Weiye Road, Hangji Industrial Park,<br/>Yangzhou City, Jiangsu Province, China, 225111",
        "email": "sg2186@vip.163.com",
        "signatory_name": "Lois Guan",
        "signatory_title": "Sales Manager",
        "stamp_path": "assets/jinxia_stamp.png",
        "signature_path": "assets/lois_guan_signature.png",
        "stamp_box": {"w": 32, "h": 32},  # circular seal
        "bank_block": [
            "<b>Incoterms:</b>&nbsp; FOB Shanghai",
            "<b>Payment:</b>&nbsp; T/T 30% deposit, 70% before shipment",
            "<b>Bank:</b>&nbsp; Bank of China, Shanghai Yangpu Sub-branch",
            "<b>Account:</b>&nbsp; 4555 7100 8120 0918 47",
            "<b>SWIFT:</b>&nbsp; BKCHCNBJ300",
        ],
    },
    "honghui": {
        "name_en": "GUANGZHOU HONGHUI DAILY TECHNOLOGY COMPANY LIMITED",
        "name_en_2line": "GUANGZHOU HONGHUI DAILY<br/>TECHNOLOGY COMPANY LIMITED",
        "name_cn": "广州虹辉日用品科技有限公司",
        "address": "Guangzhou, Guangdong Province, China",
        "email": None,
        "signatory_name": "Ellen Wei",
        "signatory_title": "Commercial Director",
        "stamp_path": "assets/honghui_stamp.png",
        "signature_path": "assets/ellen_wei_signature.png",
        "stamp_box": {"w": 38, "h": 28},  # oval seal, slightly wider than tall
        "bank_block": [
            "<b>Incoterms:</b>&nbsp; FOB Guangzhou",
            "<b>Payment:</b>&nbsp; T/T 30% deposit, 70% before shipment",
            "<b>Contract:</b>&nbsp; pulled from operation",
        ],
    },
    "wdaa": {
        "name_en": "WORLD DENTISTS ASSOCIATION AMERICA LIMITED",
        "name_en_2line": "WORLD DENTISTS ASSOCIATION<br/>AMERICA LIMITED",
        "name_cn": None,
        "address": "Hong Kong SAR, China",
        "email": None,
        "signatory_name": "Ellen Wei",
        "signatory_title": "Commercial Director",
        "stamp_path": "assets/wdaa_stamp_with_signature.png",
        "signature_path": "assets/_not_used.png",  # signature baked into stamp
        "stamp_box": {"w": 75, "h": 22},  # narrower stamp now (25% reduction)
        "bank_block": [
            "<b>Incoterms:</b>&nbsp; FOB Hong Kong",
            "<b>Payment:</b>&nbsp; T/T 30% deposit, 70% before shipment",
            "<b>Contract:</b>&nbsp; pulled from operation",
        ],
    },
}


# ===== Buyer profiles (our companies) =====
BUYERS = {
    "dee": {
        "name_en": "DAS EXPERTEN EURASIA LLC",
        "address": "430034, Republic of Mordovia, Saransk,<br/>Promyshlennaya 1-YA st., bldg 23, premises 4,<br/>Russian Federation",
        "tax_block": "INN <b>9704117379</b> &nbsp;·&nbsp; KPP <b>130001001</b>",
    },
    "dei": {
        "name_en": "DAS EXPERTEN INTERNATIONAL LLC",
        "address": "Shams Business Center, Sharjah Media City Free Zone,<br/>Al Messaned, Sharjah, United Arab Emirates",
        "tax_block": "TRN <b>104184998300001</b>",
    },
}


# ===== Currency =====
CCY = {
    "CNY": {"sym": "¥", "code": "CNY", "word": "RMB", "unit": "yuan", "sub": "fen"},
    "USD": {"sym": "$", "code": "USD", "word": "USD", "unit": "dollars", "sub": "cents"},
    "EUR": {"sym": "€", "code": "EUR", "word": "EUR", "unit": "euros", "sub": "cents"},
}


def amount_in_words(amount, currency):
    c = CCY[currency]
    whole = int(amount)
    frac = round((amount - whole) * 100)
    words_whole = num2words(whole, lang="en").replace(",", "").capitalize()
    return f"{c['word']} {words_whole} {c['unit']} and {frac:02d}/100 {c['sub']}"


def dash_if_missing(val):
    if val is None or val == "" or str(val).startswith("placeholder_"):
        return "—"
    return str(val)


def fetch_operation(op_id):
    op = d1(f"SELECT * FROM operations WHERE id = '{op_id}'")[0]
    lines = d1(
        "SELECT p.id AS sku, p.invoice_label_en, p.invoice_label_cn, "
        "li.qty, li.cartons, li.unit_price, li.line_amount "
        "FROM line_items li LEFT JOIN products p ON p.id = li.product_id "
        f"WHERE li.operation_id = '{op_id}' ORDER BY p.id"
    )
    return op, lines


def pick_seller_id(op):
    # Prefer explicit legal_seller_id, fall back to manufacturer, then partner
    for key in ("legal_seller_id", "manufacturer_id", "partner_id"):
        v = op.get(key)
        if v and v in SELLERS:
            return v
    raise RuntimeError(f"No seller profile for op {op['reference']}")


# ===== PDF builder (parameterized by compression level) =====
def _build_at_level(op, lines, level_idx, output_path):
    body_font, row_pad, meta_pad, aiw_pad, spacer_mm, margin_mm = (
        COMPRESSION[level_idx][1], COMPRESSION[level_idx][2], COMPRESSION[level_idx][3],
        COMPRESSION[level_idx][4], COMPRESSION[level_idx][5], COMPRESSION[level_idx][6],
    )

    seller_id = pick_seller_id(op)
    seller = SELLERS[seller_id]
    buyer = BUYERS[op["our_company_id"]]
    ccy = CCY[op["currency"]]
    op_date = dt.datetime.fromtimestamp(op["operation_date"], tz=dt.timezone.utc).strftime("%d %b %Y")
    invoice_no = op["reference"]
    contract = dash_if_missing(op["contract_id"])

    # Assert seller assets exist (clear error if not yet uploaded)
    # Stamp is mandatory (legal mark in CN). Signature is optional — falls back to name+title only.
    if not os.path.exists(seller["stamp_path"]):
        raise FileNotFoundError(
            f"Missing seller stamp: {seller['stamp_path']}. Upload it before generating {invoice_no}."
        )
    has_signature = os.path.exists(seller["signature_path"])

    # ---- Build styles scaled by level ----
    def st(name, font=BASE, size=9, leading=11, color=INK, align=TA_LEFT, **kw):
        return ParagraphStyle(name=name, fontName=font, fontSize=size, leading=leading,
                              textColor=color, alignment=align, **kw)

    S_TITLE = st("title", BASE_B, 18, 22, align=TA_RIGHT)
    S_TITLE_CN = st("title_cn", CJK, 11, 14, color=MUTED, align=TA_RIGHT)
    S_SELLER_NAME = st("seller_name", BASE_B, 11, 13)
    S_SELLER_CN = st("seller_cn", CJK, 10, 13, color=MUTED)
    S_LABEL = st("label", BASE, 7.5, 10, color=MUTED)
    S_LABEL_CN = st("label_cn", CJK, 7.5, 10, color=MUTED)
    S_BODY = st("body", BASE, body_font + 0.5, body_font + 3.5)
    S_BODY_B = st("body_b", BASE_B, body_font + 0.5, body_font + 3.5)
    S_BODY_SMALL = st("body_small", BASE, body_font - 0.5, body_font + 1.5, color=MUTED)
    S_META_LABEL = st("meta_label", BASE, 7, 9, color=MUTED)
    S_META_VAL = st("meta_val", BASE_B, 10, 12)
    S_TH = st("th", BASE_B, 8, 10, color=WHITE)
    S_TH_R = st("th_r", BASE_B, 8, 10, color=WHITE, align=TA_RIGHT)
    S_TD = st("td", BASE, body_font, body_font + 2)
    S_TD_SKU = st("td_sku", BASE_B, body_font - 1, body_font + 1.5, color=MUTED)
    S_TD_R = st("td_r", BASE_B, body_font, body_font + 2, align=TA_RIGHT)
    S_TOTAL_LBL = st("total_lbl", BASE_B, body_font + 1, body_font + 3.5)
    S_TOTAL_VAL = st("total_val", BASE_B, body_font + 2.5, body_font + 4.5, align=TA_RIGHT)
    S_TERMS_LBL = st("terms_lbl", BASE, 7.5, 10, color=MUTED)
    S_TERMS = st("terms", BASE, 8.5, 12)
    S_SIG_LBL = st("sig_lbl", BASE, 7.5, 10, color=MUTED, align=TA_RIGHT)
    S_SIG_NAME = st("sig_name", BASE_B, 10, 12, align=TA_RIGHT)

    doc = BaseDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=margin_mm * mm,
        rightMargin=margin_mm * mm,
        topMargin=(margin_mm - 4) * mm,
        bottomMargin=(margin_mm - 2) * mm,
        title=f"Commercial Invoice {invoice_no}",
        author=seller["name_en"],
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                  id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(
        id="all", frames=[frame],
        onPage=lambda c, d: _draw_footer(c, d, seller),
    )])

    story = []
    page_w = doc.width

    # HEADER
    seller_lines = [
        [Paragraph("SELLER&nbsp;&nbsp;|&nbsp;&nbsp;<font name='CJK'>卖方</font>", S_LABEL)],
        [Paragraph(seller["name_en_2line"], S_SELLER_NAME)],
    ]
    if seller["name_cn"]:
        seller_lines.append([Paragraph(seller["name_cn"], S_SELLER_CN)])

    header = Table(
        [[Table(seller_lines, colWidths=[page_w * 0.55]),
          Table([[Paragraph("COMMERCIAL INVOICE", S_TITLE)],
                 [Paragraph("商业发票 · PACKING SPECIFICATION", S_TITLE_CN)]],
                colWidths=[page_w * 0.4])]],
        colWidths=[page_w * 0.55, page_w * 0.45],
    )
    header.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("LINEBELOW", (0, 0), (-1, -1), 1.5, INK),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(header)
    story.append(Spacer(1, spacer_mm * mm))

    # FROM / TO
    from_rows = [
        [Paragraph("FROM&nbsp;&nbsp;|&nbsp;&nbsp;<font name='CJK'>卖方信息</font>", S_LABEL)],
        [Paragraph(seller["name_en"], S_BODY_B)],
        [Paragraph(seller["address"], S_BODY_SMALL)],
    ]
    if seller["email"]:
        from_rows.append([Paragraph(seller["email"], S_BODY_SMALL)])

    to_rows = [
        [Paragraph("BUYER&nbsp;&nbsp;|&nbsp;&nbsp;<font name='CJK'>买方信息</font>", S_LABEL)],
        [Paragraph(buyer["name_en"], S_BODY_B)],
        [Paragraph(buyer["address"], S_BODY_SMALL)],
        [Paragraph(buyer["tax_block"], S_BODY_SMALL)],
    ]
    party = Table(
        [[Table(from_rows, colWidths=[page_w * 0.48]),
          Table(to_rows, colWidths=[page_w * 0.48])]],
        colWidths=[page_w * 0.5, page_w * 0.5],
    )
    party.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(party)
    story.append(Spacer(1, spacer_mm * mm))

    # META
    def meta_cell(label_en, label_cn, value):
        return Table(
            [[Paragraph(label_en, S_META_LABEL)],
             [Paragraph(label_cn, S_LABEL_CN)],
             [Paragraph(value, S_META_VAL)]],
            colWidths=[None]
        )
    currency_disp = f"{ccy['code']}&nbsp;<font name='CJK'>元</font>" if op["currency"] == "CNY" else ccy["code"]
    meta = Table([[
        meta_cell("INVOICE No", "发票号", invoice_no),
        meta_cell("DATE", "日期", op_date),
        meta_cell("CONTRACT", "合同号", contract),
        meta_cell("CURRENCY", "币种", currency_disp),
    ]], colWidths=[page_w / 4] * 4)
    meta.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BAND),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), meta_pad),
        ("BOTTOMPADDING", (0, 0), (-1, -1), meta_pad),
    ]))
    story.append(meta)
    story.append(Spacer(1, spacer_mm * mm))

    # LINE ITEMS
    code = ccy["code"]
    sym = ccy["sym"]
    header_row = [
        Paragraph("SKU", S_TH),
        Paragraph("DESCRIPTION&nbsp;&nbsp;|&nbsp;&nbsp;<font name='CJK'>商品名称</font>", S_TH),
        Paragraph("QTY", S_TH_R),
        Paragraph("CTNS", S_TH_R),
        Paragraph(f"UNIT&nbsp;{code}", S_TH_R),
        Paragraph(f"AMOUNT&nbsp;{code}", S_TH_R),
    ]

    body_rows = []
    total_qty = 0
    total_ctn = 0
    total_amt = 0.0
    for r in lines:
        sku = (r["sku"] or "").upper()
        desc_en = r["invoice_label_en"] or sku
        desc_cn = r["invoice_label_cn"] or ""
        desc_html = desc_en
        if desc_cn:
            desc_html += f"<br/><font name='CJK' size='{body_font - 1}' color='#888'>{desc_cn}</font>"
        qty = r["qty"] or 0
        ctn = r["cartons"] or 0
        price = r["unit_price"] or 0
        amt = r["line_amount"] or 0
        total_qty += qty
        total_ctn += ctn
        total_amt += amt
        body_rows.append([
            Paragraph(sku, S_TD_SKU),
            Paragraph(desc_html, S_TD),
            Paragraph(f"{qty:,}", S_TD_R),
            Paragraph(f"{ctn}" if ctn else "—", S_TD_R),
            Paragraph(f"{price:.4f}".rstrip('0').rstrip('.') if price < 1 else f"{price:.3f}", S_TD_R),
            Paragraph(f"{amt:,.2f}", S_TD_R),
        ])

    totals_row = [
        Paragraph("TOTAL&nbsp;&nbsp;|&nbsp;&nbsp;<font name='CJK'>总计</font>", S_TOTAL_LBL),
        "",
        Paragraph(f"{total_qty:,}", S_TOTAL_VAL),
        Paragraph(f"{total_ctn}" if total_ctn else "—", S_TOTAL_VAL),
        "",
        Paragraph(f"{sym}&nbsp;{total_amt:,.2f}", S_TOTAL_VAL),
    ]

    col_widths = [
        page_w * 0.11, page_w * 0.35, page_w * 0.12,
        page_w * 0.08, page_w * 0.13, page_w * 0.21,
    ]
    table_data = [header_row] + body_rows + [totals_row]
    items_table = Table(table_data, colWidths=col_widths, repeatRows=1)
    items_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BLACK_BAR),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("VALIGN", (0, 0), (-1, 0), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, 0), 4),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("VALIGN", (0, 1), (-1, -2), "TOP"),
        ("TOPPADDING", (0, 1), (-1, -2), row_pad),
        ("BOTTOMPADDING", (0, 1), (-1, -2), row_pad),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 1), (-1, -2), 0.4, LINE),
        ("BACKGROUND", (0, -1), (-1, -1), BAND),
        ("SPAN", (0, -1), (1, -1)),
        ("SPAN", (4, -1), (4, -1)),
        ("VALIGN", (0, -1), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, -1), (-1, -1), row_pad + 3),
        ("BOTTOMPADDING", (0, -1), (-1, -1), row_pad + 3),
        ("LINEABOVE", (0, -1), (-1, -1), 1.0, INK),
    ]))
    story.append(items_table)
    story.append(Spacer(1, spacer_mm * mm))

    # AMOUNT IN WORDS
    aiw = Table(
        [[Paragraph("AMOUNT IN WORDS&nbsp;&nbsp;|&nbsp;&nbsp;<font name='CJK'>金额大写</font>", S_TERMS_LBL),
          Paragraph(amount_in_words(total_amt, op["currency"]), S_BODY_B)]],
        colWidths=[page_w * 0.32, page_w * 0.68]
    )
    aiw.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BAND),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), aiw_pad),
        ("BOTTOMPADDING", (0, 0), (-1, -1), aiw_pad),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
    ]))
    story.append(aiw)
    story.append(Spacer(1, spacer_mm * mm))

    # TERMS + SIGNATURE
    terms_lines = seller["bank_block"]
    terms_block = [
        [Paragraph("TERMS&nbsp;&nbsp;|&nbsp;&nbsp;<font name='CJK'>条款</font>", S_TERMS_LBL)],
        [Spacer(1, 3)],
    ] + [[Paragraph(line, S_TERMS)] for line in terms_lines]

    sig_label = [
        [Paragraph("AUTHORIZED SIGNATORY&nbsp;&nbsp;|&nbsp;&nbsp;<font name='CJK'>授权签字</font>", S_SIG_LBL)],
        [Paragraph(f"{seller['signatory_name']}&nbsp;&nbsp;·&nbsp;&nbsp;{seller['signatory_title']}", S_SIG_NAME)],
    ]

    # HARD RULE: preserve aspect ratio. Each image is bounded by EITHER width or height,
    # never both — the other dimension follows from the source aspect ratio.
    from PIL import Image as PILImage

    def fit_image(path, max_w_mm, max_h_mm):
        with PILImage.open(path) as pim:
            src_w, src_h = pim.size
        src_aspect = src_w / src_h
        w = max_w_mm
        h = w / src_aspect
        if h > max_h_mm:
            h = max_h_mm
            w = h * src_aspect
        return RLImage(path, width=w * mm, height=h * mm)

    # Per-seller stamp box (some chops are wide rectangles, not circles)
    sb = seller.get("stamp_box", {"w": 36, "h": 32})
    stamp_img = fit_image(seller["stamp_path"], max_w_mm=sb["w"], max_h_mm=sb["h"])

    # Long horizontal text chops need to be stacked above the signature,
    # not placed beside it, to avoid bleeding into the terms column.
    is_long_chop = sb["w"] > 50

    if has_signature:
        sig_img = fit_image(seller["signature_path"], max_w_mm=42, max_h_mm=12)
        if is_long_chop:
            # Stack: stamp on top, signature below it (both right-aligned)
            sig_visual = Table(
                [[stamp_img], [sig_img]],
                colWidths=[sb["w"] * mm + 4 * mm]
            )
            sig_visual.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]))
        else:
            sig_visual = Table([[sig_img, stamp_img]],
                               colWidths=[44 * mm, (sb["w"] + 4) * mm])
            sig_visual.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (0, 0), "CENTER"),
                ("ALIGN", (1, 0), (1, 0), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]))
    else:
        if is_long_chop:
            sig_visual = Table([[stamp_img]], colWidths=[(sb["w"] + 4) * mm])
        else:
            sig_visual = Table([["", stamp_img]],
                               colWidths=[44 * mm, (sb["w"] + 4) * mm])
        sig_visual.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (-1, 0), (-1, 0), "RIGHT" if is_long_chop else "CENTER"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ]))
    sig_block = Table(
        [[c] for c in (sig_label[0] + sig_label[1] + [[sig_visual]])],
        colWidths=[page_w * 0.58 - 4 * mm]
    )
    sig_block.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
    ]))

    bottom = Table(
        [[Table(terms_block, colWidths=[page_w * 0.42]), sig_block]],
        colWidths=[page_w * 0.42, page_w * 0.58],
    )
    bottom.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
    ]))
    story.append(bottom)

    doc.build(story)


def _draw_footer(canv: canvas_mod.Canvas, doc, seller):
    canv.saveState()
    w, h = A4
    canv.setStrokeColor(LINE)
    canv.setLineWidth(0.4)
    canv.line(18 * mm, 12 * mm, w - 18 * mm, 12 * mm)
    canv.setFillColor(MUTED)
    canv.setFont(BASE, 7)
    pre = f"{seller['name_en']}  ·  "
    canv.drawString(18 * mm, 8 * mm, pre)
    tw = canv.stringWidth(pre, BASE, 7)
    if seller["name_cn"]:
        canv.setFont(CJK, 7)
        canv.drawString(18 * mm + tw, 8 * mm, seller["name_cn"])
    canv.setFont(BASE, 7)
    canv.drawRightString(w - 18 * mm, 8 * mm, f"Page {canv.getPageNumber()}")
    canv.restoreState()


def build_pdf_autofit(op_id, output_path, verbose=False):
    """
    HARD RULE: render the invoice, count pages, if >1 retry with tighter
    settings up to len(COMPRESSION) levels. Stops at the first single-page
    render. If even max compression overflows, keeps the last attempt and
    returns it with a warning flag.
    """
    op, lines = fetch_operation(op_id)
    seller_id = pick_seller_id(op)
    last_level = None
    page_count = None
    for level_idx, settings in enumerate(COMPRESSION):
        try:
            _build_at_level(op, lines, level_idx, output_path)
        except Exception as e:
            return {"ok": False, "error": str(e), "level": settings[0]}
        reader = PdfReader(output_path)
        page_count = len(reader.pages)
        last_level = settings[0]
        if verbose:
            print(f"    [{op['reference']}] {settings[0]} -> {page_count} page(s)")
        if page_count == 1:
            return {"ok": True, "level": last_level, "pages": 1, "seller": seller_id}
    # Couldn't fit even at max compression
    return {"ok": True, "level": last_level, "pages": page_count, "seller": seller_id, "warning": "overflow"}


if __name__ == "__main__":
    # Verify the autofit works on all 4 Jinxia operations (regression test)
    targets = [
        ("op_7787847d-c497-4f38-bb98-5710367f6297", "JINX-26052101"),
        ("op_f2654d8f-bd92-480d-8136-0ddadb696f9e", "JINX-26052103"),
        ("op_f581ff00-9980-4bf7-bcd6-8c7a15291dac", "DEI-010"),
        ("op_1a06beec-4449-4b0b-9078-483abfebdc77", "JINX-26031701"),
    ]
    for op_id, ref in targets:
        out = f"/mnt/user-data/outputs/{ref}_invoice.pdf"
        result = build_pdf_autofit(op_id, out, verbose=True)
        flag = "OK " if result.get("pages") == 1 else "WARN"
        print(f"  {flag} {ref}: pages={result.get('pages')} compression={result['level']} -> {out}")

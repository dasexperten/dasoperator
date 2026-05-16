#!/bin/bash
set -e
set -u

# Create scraper user dir
mkdir -p /home/telegramer/ozon-scraper
cd /home/telegramer/ozon-scraper

# Write .env
cat > .env << 'ENVEOF'
OZON_COOKIES=sc_company_id=374116; ob_theme=SYSTEM; __Secure-ab-group=64; __Secure-user-id=85607026; bacntid=904890; __Secure-ext_xcid=de15566c1f1508f63d637007af0ea422; __Secure-product-user-id=85607026; __Secure-sid=sc1.rKCVF8NPSeqzcMu1cjdbFg.AaayqW3jQIdurHzDpjdiv2jUntfQYTYYp1kjO-SO348N2si4PgLa4F168M9nRGJpyw_CdnST17UKY9pTL98gB0A.u1dUo5aCg96mMtW1vYkBZfxKE3LHZigM6t6qW5OSIjg.1dc871e7c60ba48a8; xcid=120a6d78ba53fd682ec962455a701e9d; x-o3-language=ru; __Secure-ETC=6646281e1d1348f4e8c8668a42810127; __Secure-token=p8.85607026.rKCVF8NPSeqzcMu1cjdbFg.64.AcpIHKRpjaBJcghfGeQ-wONeNDR5ht02zaIY3-IL9uLp-IP3QYYwtakTZ_l4JsaXDtdk3uTGn52AKJRkUbpTzD7OK2-b1ZQcAcU-fe7ILjN2N6UkgoIHP3XE2iEIL0mRLOh4EbjfnWiOxWKw7DNTvWTdOS5e7JR_mPCEbMgxgenvVD7hugwsap4Ti8qtvIUs7zUB5xMMNums7E0clS7Q0bQuClF6VtbLIHx8uw8j8bZo.20211216192225.20260516172554.1.UCSEnsZBhxQXSZZ1rE6PJ4QMiHWVSZ7DWgXcAwiEkzg.15981274dd56f3a01; __Secure-access-token=12.85607026.rKCVF8NPSeqzcMu1cjdbFg.64.AeBJozJ9xC_GmQoMdOk99qh022HAElD52RQf93eFkmzU_-wvP-JtVTf7nEZ5Tpp57tFonkiDETVXm_uyoYDd32U6i4AMwvaid6WRDI5AcG58zJOe5z7XHaaMOs9-o8tpAefSlNojzMKR0xSXyQXwnE0.20211216192225.20260516175354.1.SkO2kJFj-wMyXDK7oak936ke4uLOHEyEroxj6-tDL1o.129dcc6cf26f93624; __Secure-refresh-token=12.85607026.rKCVF8NPSeqzcMu1cjdbFg.64.AeBJozJ9xC_GmQoMdOk99qh022HAElD52RQf93eFkmzU_-wvP-JtVTf7nEZ5Tpp57tFonkiDETVXm_uyoYDd32U6i4AMwvaid6WRDI5AcG58zJOe5z7XHaaMOs9-o8tpAefSlNojzMKR0xSXyQXwnE0.20211216192225.20260516175354.1.Rx8UG-hWVHz8HEELdlrIkUNGB0XnE65QSSeNX5q5qK0.1910233f972ad9611
INGEST_SECRET=8268691cd8a0ea7d3172099b0b5ea9be12915f2dcba296e1ef32f4f7caef116d
WORKER_URL=https://dasoperator-api.dasexperten.workers.dev/api/marketplaces/ozon/portal-ingest
ENVEOF
chmod 600 .env

# Write scraper
cat > scraper.py << 'PYEOF_INNER'
#!/usr/bin/env python3
"""
Ozon Seller Portal scraper for Das Operator ERP.
Runs on Hetzner VPS via systemd timer every 30 min.
Fetches "remainingActionStock" for all participating promotions.
POSTs results to Cloudflare Worker for storage in KV.
"""
import http.cookiejar
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ENV_FILE = Path("/home/telegramer/ozon-scraper/.env")

def load_env():
    env = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
    return env

def build_opener(cookies_str):
    jar = http.cookiejar.CookieJar()
    for part in cookies_str.split("; "):
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        cookie = http.cookiejar.Cookie(
            version=0, name=name, value=value,
            port=None, port_specified=False,
            domain=".ozon.ru", domain_specified=True, domain_initial_dot=True,
            path="/", path_specified=True,
            secure=name.startswith("__Secure-"),
            expires=None, discard=True, comment=None, comment_url=None,
            rest={"HttpOnly": None},
        )
        jar.set_cookie(cookie)
    opener = urllib.request.build_opener(
        urllib.request.HTTPRedirectHandler(),
        urllib.request.HTTPCookieProcessor(jar),
    )
    return opener, jar

def ozon_get(opener, url):
    req = urllib.request.Request(url, headers={
        "accept": "application/json, text/plain, */*",
        "accept-language": "ru,en;q=0.9",
        "referer": "https://seller.ozon.ru/app/highlights/",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "x-o3-company-id": "374116",
        "x-o3-language": "ru",
    })
    with opener.open(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, body

def fetch_action_list(opener):
    """Get list of all active actions. Uses v1/seller-actions endpoint."""
    url = "https://seller.ozon.ru/api/site/seller-actions/v1/seller-actions?type=active&with_drafts=false"
    try:
        status, body = ozon_get(opener, url)
        if status != 200:
            print(f"[WARN] action list HTTP {status}", file=sys.stderr)
            return []
        data = json.loads(body)
        # Try common shapes
        items = data.get("sellerActions") or data.get("actions") or data.get("items") or []
        if isinstance(data, dict) and "result" in data:
            items = data["result"].get("sellerActions", []) or items
        ids = []
        for item in items:
            aid = item.get("id") or item.get("actionId") or item.get("action_id")
            if aid:
                ids.append(int(aid))
        return ids
    except Exception as e:
        print(f"[ERR] fetch_action_list: {e}", file=sys.stderr)
        return []

def fetch_action_products(opener, action_id):
    """Fetch all products in an action with remainingActionStock."""
    results = []
    offset = 0
    limit = 100
    for _ in range(20):  # max 2000 products per action
        url = f"https://seller.ozon.ru/api/site/global-seller-products/v1/action/{action_id}/products/active?offset={offset}&limit={limit}"
        try:
            status, body = ozon_get(opener, url)
            if status != 200:
                print(f"[WARN] action {action_id} HTTP {status}", file=sys.stderr)
                return results
            data = json.loads(body)
            products = data.get("products", [])
            for p in products:
                try:
                    pid = int(p["id"])
                    qty = int(p.get("quantity", "0") or "0")
                    remaining = int(p.get("remainingActionStock", "0") or "0")
                    sold = max(0, qty - remaining)
                    results.append({
                        "product_id": pid,
                        "sold": sold,
                        "is_sold_out": bool(p.get("isActionStockSold", False)),
                    })
                except (ValueError, KeyError):
                    continue
            if len(products) < limit:
                break
            offset += len(products)
        except Exception as e:
            print(f"[ERR] action {action_id} offset={offset}: {e}", file=sys.stderr)
            return results
    return results

def post_to_worker(secret, worker_url, data):
    payload = json.dumps({"secret": secret, "data": data}).encode("utf-8")
    req = urllib.request.Request(
        worker_url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")

def main():
    env = load_env()
    cookies = env.get("OZON_COOKIES", "")
    secret = env.get("INGEST_SECRET", "")
    worker_url = env.get("WORKER_URL", "https://dasoperator-api.dasexperten.workers.dev/api/marketplaces/ozon/portal-ingest")
    if not cookies or not secret:
        print("[FATAL] OZON_COOKIES or INGEST_SECRET missing in .env", file=sys.stderr)
        sys.exit(1)

    opener, _jar = build_opener(cookies)

    # 1) Get all active action IDs
    action_ids = fetch_action_list(opener)
    if not action_ids:
        print("[FATAL] no action IDs returned — session likely expired", file=sys.stderr)
        sys.exit(2)

    print(f"[INFO] {len(action_ids)} active actions: {action_ids}", file=sys.stderr)

    # 2) Fetch products for each
    data = []
    for aid in action_ids:
        products = fetch_action_products(opener, aid)
        print(f"[INFO] action {aid}: {len(products)} products", file=sys.stderr)
        if products:
            data.append({"action_id": aid, "products": products})
        time.sleep(1)  # polite delay between actions

    if not data:
        print("[FATAL] no product data fetched", file=sys.stderr)
        sys.exit(3)

    # 3) Push to Worker
    status, resp = post_to_worker(secret, worker_url, data)
    print(f"[INFO] worker POST: HTTP {status}", file=sys.stderr)
    print(resp, file=sys.stderr)
    if status >= 300:
        sys.exit(4)

    print(f"[OK] scraped {sum(len(d['products']) for d in data)} products across {len(data)} actions", file=sys.stderr)

if __name__ == "__main__":
    main()
PYEOF_INNER
chmod +x scraper.py

# Systemd unit
cat > /etc/systemd/system/ozon-scraper.service << 'UNIT'
[Unit]
Description=Ozon Seller Portal Scraper for Das Operator
After=network-online.target

[Service]
Type=oneshot
User=root
WorkingDirectory=/home/telegramer/ozon-scraper
ExecStart=/usr/bin/python3 /home/telegramer/ozon-scraper/scraper.py
StandardOutput=journal
StandardError=journal
UNIT

# Systemd timer (every 30 min)
cat > /etc/systemd/system/ozon-scraper.timer << 'TIMER'
[Unit]
Description=Run Ozon scraper every 30 min

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
Unit=ozon-scraper.service

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable ozon-scraper.timer
systemctl start ozon-scraper.timer
echo "--- Running first scrape now ---"
systemctl start ozon-scraper.service
sleep 8
echo "--- Last 30 lines of scraper log ---"
journalctl -u ozon-scraper.service -n 30 --no-pager

#!/bin/bash
set -euo pipefail
umask 077

# Credentials are supplied separately from the private vault, never in this repo.
# --check-env validates the input without touching services, files or the network.
check_only=false
if [[ "${1:-}" == "--check-env" ]]; then
  check_only=true
  shift
fi
if [[ "$#" -ne 1 || "$1" != /* || ! -f "$1" || -L "$1" || ! -r "$1" ]]; then
  echo "Usage: $0 [--check-env] /absolute/path/to/private.env" >&2
  exit 64
fi
scraper_env_source="$1"
python3 - "$scraper_env_source" <<'VALIDATE_ENV'
import os
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
if stat.S_IMODE(path.stat().st_mode) & 0o077:
    sys.exit("Credential file must be private (chmod 600).")
values = {}
for line in path.read_text().splitlines():
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    name, separator, value = line.partition("=")
    if not separator or name.strip() in values:
        sys.exit("Credential file has invalid or duplicate fields.")
    values[name.strip()] = value.strip()
if not values.get("OZON_COOKIES") or len(values.get("INGEST_SECRET", "")) < 32:
    sys.exit("Credential file requires OZON_COOKIES and INGEST_SECRET.")
if values.get("WORKER_URL") != "https://dasoperator-api.dasexperten.workers.dev/api/marketplaces/ozon/portal-ingest":
    sys.exit("Credential file has an unsupported ingest destination.")
print("Credential file validated; values not displayed.")
VALIDATE_ENV
if [[ "$check_only" == true ]]; then
  exit 0
fi
if [[ "$EUID" -ne 0 ]]; then
  echo "Installation requires root; validation made no changes." >&2
  exit 77
fi

# Create scraper user dir, then copy only the explicitly supplied private file.
mkdir -p /home/telegramer/ozon-scraper
install -m 600 "$scraper_env_source" /home/telegramer/ozon-scraper/.env
cd /home/telegramer/ozon-scraper

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

#!/usr/bin/env python3
"""Local client for the ERP's Ozon copy queue. JSON commands read one stdin object."""
import argparse
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('operation', choices='job tickets run catalog card reserve ticket finish'.split())
op = parser.parse_args().operation
local = Path.home() / '.local/share/dasexperten/ozon-copy'
headers = {'Authorization': 'Bearer ' + (local/'device-token').read_text().strip(),
           'Content-Type': 'application/json', 'User-Agent': 'DasExperten-ERP-Ozon/1.0'}
body = None if op in ('job', 'tickets') else ({} if op == 'run' else json.load(sys.stdin))
req = Request('https://erp-ozon-copy-check.dasexperten.workers.dev/' + op,
              data=None if body is None else json.dumps(body).encode(), headers=headers)
try:
    with urlopen(req, timeout=35) as response:
        print(response.read().decode())
except HTTPError as exc:
    print(f'ERP HTTP {exc.code}: {exc.read().decode()}', file=sys.stderr)
    sys.exit(1)

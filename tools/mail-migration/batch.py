"""Sequential, resumable migration of indexed business mail. No sends or deletes.

D1 is an inventory, not proof of complete R2 coverage. Unregistered mailboxes and
per-record failures are reported explicitly for reconciliation, not discarded.
"""
import argparse
import collections
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from migrate import business_addresses, request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace-config', required=True)
    parser.add_argument('--receipts', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--database-id', required=True)
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    url = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/d1/database/' + args.database_id + '/query'
    data = json.loads(request(url, os.environ['CLOUDFLARE_API_TOKEN'], {'sql': 'SELECT message_key,mailbox FROM mail_index ORDER BY timestamp,message_key'}))
    if not data.get('success') or not data['result'][0].get('success'):
        raise RuntimeError('Inventory failed')
    rows = data['result'][0]['results']
    allowed = business_addresses()
    report = {'indexed': len(rows), 'outOfScope': dict(collections.Counter(r['mailbox'] for r in rows if r['mailbox'] not in allowed)), 'alreadyVerified': 0, 'processed': [], 'remaining': 0}
    done = set()
    if Path(args.receipts).exists():
        with sqlite3.connect(args.receipts) as db:
            done = {r[0] for r in db.execute("SELECT source FROM receipts WHERE status IN ('verified','existing')")}
    eligible = [r for r in rows if r['mailbox'] in allowed]
    report['alreadyVerified'] = sum(r['message_key'] in done for r in eligible)
    pending = [r for r in eligible if r['message_key'] not in done]
    selected = pending[:args.limit] if args.limit else pending
    report['remaining'] = len(pending) - len(selected)
    def save():
        path = Path(args.report)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, indent=2))
        temporary.replace(path)
    save()
    print(json.dumps({'indexed': len(rows), 'selected': len(selected), 'alreadyVerified': report['alreadyVerified'], 'outsideRegistry': sum(report['outOfScope'].values())}), flush=True)
    for index, row in enumerate(selected):
        command = [sys.executable, str(Path(__file__).with_name('migrate.py')), '--workspace-config', args.workspace_config, '--receipts', args.receipts, '--record-key', row['message_key']]
        if args.apply:
            command.append('--apply')
        # Never kill an import on an observation timeout: the per-record client
        # handles HTTP timeouts and keeps a pending receipt before a write.
        result = subprocess.run(command, capture_output=True, text=True)
        try:
            outcome = json.loads(result.stdout)
        except (ValueError, TypeError):
            outcome = {'failed': True, 'reason': 'No structured result; inspect receipt before retry'}
        if result.returncode and not outcome.get('failed'):
            outcome = {'failed': True, 'reason': 'Migration process failed'}
        report['processed'].append({'source': row['message_key'], **outcome})
        save()
        print(json.dumps({'position': index + 1, 'total': len(selected), 'mailbox': row['mailbox'], **outcome}), flush=True)
    print(json.dumps({'finished': True, 'verified': sum(bool(r.get('verified')) for r in report['processed']), 'failed': sum(bool(r.get('failed')) for r in report['processed']), 'remaining': report['remaining']}), flush=True)


if __name__ == '__main__':
    main()

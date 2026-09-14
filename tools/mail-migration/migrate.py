"""Copy legacy R2 records into Gmail; never send mail or delete source objects.

Credentials come from the environment and a private Workspace configuration file.
Only mapping receipts (keys, hashes, Gmail IDs) are persisted locally, not bodies.
An uncertain import is blocked on subsequent runs until its Gmail result is found.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import format_datetime
from pathlib import Path


def business_addresses():
    registry = (Path(__file__).resolve().parents[2] / 'api/src/lib/mailbox-registry.ts').read_text()
    # Read actual UI registry entries, never addresses mentioned in comments.
    entries = [line for line in registry.splitlines() if re.match(r'\s*\{ address:', line) and 'showInUi: true' in line]
    return set(re.findall(r'[a-z0-9._+-]+@dasexperten\.(?:com|ru)', '\n'.join(entries)))


def request(url, token=None, data=None, method=None, form=False):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if data is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
        data = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        # Never include provider response bodies, URLs or request credentials.
        raise RuntimeError('Provider HTTP ' + str(error.code)) from None


def fingerprint(raw, ignore_message_id=False):
    message = BytesParser(policy=policy.default).parsebytes(raw)
    headers = {h: str(message.get(h, '')) for h in ['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Subject', 'Message-ID', 'In-Reply-To', 'References']}
    if ignore_message_id:
        headers.pop('Message-ID')
    parts = []
    for part in message.walk():
        if part.is_multipart():
            continue
        data = part.get_payload(decode=True) or b''
        if part.get_content_maintype() == 'text' and not part.get_filename():
            data = part.get_content().replace('\r\n', '\n').rstrip('\n').encode()
        parts.append((part.get_content_type(), part.get_filename(), str(part.get('Content-ID', '')), part.get_content_disposition(), hashlib.sha256(data).hexdigest()))
    return hashlib.sha256(json.dumps([headers, parts], sort_keys=True).encode()).hexdigest()


def verified_content_equal(raw, restored, key):
    if fingerprint(raw) == fingerprint(restored):
        return True
    source = BytesParser(policy=policy.default).parsebytes(raw)
    parsed = BytesParser(policy=policy.default).parsebytes(restored)
    invalid_id = not re.fullmatch(r'<[^<>\s]+@[^<>\s]+>', str(source.get('Message-ID', '')))
    # MIME folding can leave whitespace around this unstructured header value.
    # Only normalize that marker, never the compared message content.
    our_marker = str(parsed.get('X-Das-ERP-Migration', '')).strip() == hashlib.sha256(key.encode()).hexdigest()
    return bool(invalid_id and our_marker and fingerprint(restored, True) == fingerprint(raw, True))


def compose(record, key, read_object):
    message = EmailMessage(policy=policy.SMTP)
    for header, field in [('From', 'from'), ('To', 'to'), ('Cc', 'cc'), ('Bcc', 'bcc'), ('Subject', 'subject'), ('Reply-To', 'replyTo')]:
        value = record.get(field)
        if value:
            message[header] = ', '.join(value) if isinstance(value, list) else value
    if not message.get('From'):
        raise ValueError('Missing original sender')
    timestamp = datetime.datetime.fromisoformat(record['timestamp'].replace('Z', '+00:00'))
    if timestamp.tzinfo is None:
        raise ValueError('Missing original timezone')
    message['Date'] = format_datetime(timestamp)
    message['Message-ID'] = record.get('messageId') or '<erp-migration-' + hashlib.sha256(key.encode()).hexdigest() + '@dasexperten.com>'
    # Legacy threadId is an RFC parent ID, not a Gmail thread ID.
    parent = record.get('inReplyTo') or record.get('threadId')
    if parent and re.fullmatch(r'<[^<>\s]+@[^<>\s]+>', parent):
        message['In-Reply-To'] = parent
    refs = record.get('references')
    if refs:
        message['References'] = ' '.join(refs) if isinstance(refs, list) else refs
    message['X-Das-ERP-Recipient'] = record['address']
    message['X-Das-ERP-Migration'] = hashlib.sha256(key.encode()).hexdigest()
    message.set_content(record.get('text') or '')
    if record.get('html'):
        message.add_alternative(record['html'], subtype='html')
    for attachment in record.get('attachments', []):
        if attachment.get('skipped') or not attachment.get('key'):
            raise ValueError('Original attachment unavailable; migration stopped')
        if not attachment['key'].startswith(key[:-5] + '/att/'):
            raise ValueError('Attachment outside source record')
        content = read_object(attachment['key'])
        if len(content) != attachment['size']:
            raise ValueError('Source attachment size mismatch')
        mime = attachment.get('mimeType') or 'application/octet-stream'
        maintype, subtype = mime.split('/', 1)
        cid = attachment.get('contentId')
        message.add_attachment(content, maintype=maintype, subtype=subtype, filename=attachment['filename'], disposition='inline' if attachment.get('inline') else 'attachment', **({'cid': '<' + cid.strip('<>') + '>'} if cid else {}))
    return message.as_bytes(), str(message['Message-ID']), int(timestamp.timestamp())


def workspace_original(record, key):
    if record.get('trigger') != 'workspace-sync':
        return None
    match = re.search(r'/workspace-([A-Za-z0-9_-]+)-([a-f0-9]+)\.json$', key)
    if not match:
        raise ValueError('Invalid Workspace source identifier')
    account = base64.urlsafe_b64decode(match[1] + '===').decode()
    if account != 'sales@dasexperten.com':
        raise ValueError('Workspace source belongs to another account')
    return account, match[2]


def normalize_record(record, key):
    match = re.fullmatch(r'Inbox/([^/]+)/(sent|received)/[^/]+\.json', key)
    if not match:
        raise ValueError('Invalid source key')
    value = dict(record)
    # Older sent-mail writers used box/sentAt and omitted direction/address.
    if 'address' not in value and value.get('box') in (match[1], match[1].split('@')[0]):
        value['address'] = match[1]
    if 'direction' not in value and value.get('sentAt') and match[2] == 'sent':
        value['direction'] = 'sent'
    if 'timestamp' not in value and value.get('sentAt') and match[2] == 'sent':
        value['timestamp'] = value['sentAt']
    if value.get('address') != match[1] or value.get('direction') != match[2]:
        raise ValueError('Source key and record disagree')
    if not value.get('timestamp'):
        raise ValueError('Original date missing')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace-config', required=True)
    parser.add_argument('--record-key', required=True)
    parser.add_argument('--receipts', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    key = args.record_key
    allowed = business_addresses()
    match = re.fullmatch(r'Inbox/([^/]+)/(sent|received)/[^/]+\.json', key)
    if not match or match[1] not in allowed:
        raise ValueError('Source is not a registered business mailbox')
    cfbase = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/r2/buckets/self-learning/objects/'
    def read_object(object_key):
        return request(cfbase + urllib.parse.quote(object_key, safe='/'), os.environ['CLOUDFLARE_API_TOKEN'])
    record = normalize_record(json.loads(read_object(key)), key)
    original = workspace_original(record, key)
    if original:
        raw = read_object('Workspace/raw/' + original[0] + '/' + original[1] + '.eml')
        message_id = str(BytesParser(policy=policy.default).parsebytes(raw).get('Message-ID', ''))
        date = int(datetime.datetime.fromisoformat(record['timestamp'].replace('Z', '+00:00')).timestamp())
    else:
        raw, message_id, date = compose(record, key, read_object)
    digest = fingerprint(raw)
    if not args.apply:
        print(json.dumps({'prepared': True, 'sourceKey': key, 'bytes': len(raw), 'attachments': len(record.get('attachments', [])), 'fingerprint': digest}))
        return
    config = json.loads(Path(args.workspace_config).read_text())
    accounts = json.loads(config['GOOGLE_WORKSPACE_ACCOUNTS'])
    account = next(a for a in accounts if a['email'] == 'sales@dasexperten.com')
    token = json.loads(request('https://oauth2.googleapis.com/token', data={'client_id': config['GOOGLE_WORKSPACE_CLIENT_ID'], 'client_secret': config['GOOGLE_WORKSPACE_CLIENT_SECRET'], 'refresh_token': account['refreshToken'], 'grant_type': 'refresh_token'}, form=True))['access_token']
    base = 'https://gmail.googleapis.com/gmail/v1/users/me/'
    def gmail(path, data=None):
        return json.loads(request(base + path, token, data))
    if gmail('profile')['emailAddress'].lower() != account['email']:
        raise ValueError('Google account mismatch')
    os.umask(0o077)
    db = sqlite3.connect(args.receipts)
    db.execute('CREATE TABLE IF NOT EXISTS receipts (source TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, gmail_id TEXT)')
    receipt = db.execute('SELECT fingerprint,status,gmail_id FROM receipts WHERE source=?', (key,)).fetchone()
    if receipt and receipt[0] != digest:
        raise ValueError('Source changed after migration attempt')
    if original:
        stored = gmail('messages/' + original[1] + '?format=raw')
        restored = base64.urlsafe_b64decode(stored['raw'] + '===')
        # The old Gmail mirror stripped sender names and MIME layout. Its full
        # raw backup is the stronger evidence; compare every byte, not just the
        # lossy reconstructed record. Missing/deleted originals are not restored
        # automatically, and this path can never call import or send.
        if restored != raw:
            raise ValueError('Original Gmail MIME differs from its backup')
        if abs(int(stored['internalDate']) // 1000 - date) > 1:
            raise ValueError('Original Gmail date mismatch')
        db.execute('INSERT OR REPLACE INTO receipts VALUES (?,?,?,?)', (key, digest, 'existing', original[1])); db.commit()
        print(json.dumps({'verified': True, 'existing': True, 'exactOriginal': True, 'gmailId': original[1]}))
        return
    def verify(gmail_id, check_date):
        stored = gmail('messages/' + gmail_id + '?format=raw')
        restored = base64.urlsafe_b64decode(stored['raw'] + '===')
        if not verified_content_equal(raw, restored, key):
            raise ValueError('Google readback content mismatch')
        if check_date and abs(int(stored['internalDate']) // 1000 - date) > 1:
            raise ValueError('Google readback date mismatch')
    if receipt and receipt[2]:
        verify(receipt[2], receipt[1] != 'existing')
        if receipt[1] == 'pending':
            db.execute("UPDATE receipts SET status='verified' WHERE source=?", (key,)); db.commit()
        print(json.dumps({'verified': True, 'reused': True, 'gmailId': receipt[2]}))
        return
    lookup_id = message_id if re.fullmatch(r'<[^<>\s]+@[^<>\s]+>', message_id) else '<erp-migration-' + hashlib.sha256(key.encode()).hexdigest() + '@dasexperten.com>'
    found = gmail('messages?' + urllib.parse.urlencode({'q': 'rfc822msgid:' + lookup_id, 'includeSpamTrash': 'true', 'maxResults': 100}))
    if found.get('nextPageToken'):
        raise ValueError('Too many duplicate candidates')
    if found.get('messages'):
        if len(found['messages']) != 1:
            raise ValueError('Multiple existing messages; resolve before importing')
        existing = found['messages'][0]['id']
        verify(existing, False)
        db.execute('INSERT OR REPLACE INTO receipts VALUES (?,?,?,?)', (key, digest, 'existing', existing)); db.commit()
        print(json.dumps({'verified': True, 'existing': True, 'gmailId': existing}))
        return
    if receipt:
        raise ValueError('Uncertain prior import: do not retry until reconciled in Google')
    db.execute('INSERT INTO receipts VALUES (?,?,?,NULL)', (key, digest, 'pending')); db.commit()
    wire_raw = raw
    if not re.fullmatch(r'<[^<>\s]+@[^<>\s]+>', message_id):
        wire_message = BytesParser(policy=policy.default).parsebytes(raw)
        wire_message.replace_header('Message-ID', '<erp-migration-' + hashlib.sha256(key.encode()).hexdigest() + '@dasexperten.com>')
        wire_raw = wire_message.as_bytes(policy=policy.SMTP)
    # Import, never send. Disable calendar side effects; preserve original date.
    result = gmail('messages/import?internalDateSource=dateHeader&processForCalendar=false', {'raw': base64.urlsafe_b64encode(wire_raw).decode(), 'labelIds': ['SENT'] if record['direction'] == 'sent' else []})
    db.execute('UPDATE receipts SET gmail_id=? WHERE source=?', (result['id'], key)); db.commit()
    verify(result['id'], True)
    db.execute("UPDATE receipts SET status='verified' WHERE source=?", (key,)); db.commit()
    print(json.dumps({'verified': True, 'imported': True, 'gmailId': result['id'], 'attachments': len(record.get('attachments', [])), 'dateVerified': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'failed': True, 'reason': str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__}))
        raise SystemExit(1)

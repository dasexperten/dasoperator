import unittest
from email import policy
from email.parser import BytesParser
from migrate import compose, fingerprint, business_addresses, workspace_original, normalize_record, verified_content_equal

class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.key='Inbox/sales@dasexperten.com/received/test.json'
        self.record={'address':'sales@dasexperten.com','direction':'received','timestamp':'2026-08-01T14:36:59.336Z','from':'Sender <sender@example.com>','to':['sales@dasexperten.com'],'cc':['cc@example.com'],'replyTo':'reply@example.com','subject':'Проверка 📬','text':'line 1\nline 2','html':'<p>Привет</p>','messageId':'<original@example.com>','threadId':'<parent@example.com>','attachments':[{'key':self.key[:-5]+'/att/0-file','size':4,'filename':'договор.pdf','mimeType':'application/pdf','inline':True,'contentId':'cid@example.com'}]}
    def test_business_scope(self):
        allowed=business_addresses()
        self.assertIn('geo@dasexperten.com',allowed)
        self.assertIn('julian@dasexperten.com',allowed)
        self.assertIn('shop@dasexperten.ru',allowed)
        self.assertIn('orders@notify.dasexperten.com',allowed)
        self.assertIn('delivery@notify.dasexperten.com',allowed)
        self.assertIn('sales@my.dasexperten.com',allowed)
        self.assertNotIn('unknown@notify.dasexperten.com',allowed)
        self.assertNotIn('dr.badalyan@dasexperten.com',allowed)
        self.assertNotIn('viktor@dasexperten.com',allowed)
    def test_workspace_original_provenance(self):
        key='Inbox/sales@dasexperten.com/received/workspace-c2FsZXNAZGFzZXhwZXJ0ZW4uY29t-19f525800d3740d4.json'
        self.assertEqual(workspace_original({'trigger':'workspace-sync'},key),('sales@dasexperten.com','19f525800d3740d4'))
        self.assertIsNone(workspace_original({},key))
        with self.assertRaises(ValueError):workspace_original({'trigger':'workspace-sync'},self.key)
        with self.assertRaises(ValueError):workspace_original({'trigger':'workspace-sync'},key.replace('c2FsZXNAZGFzZXhwZXJ0ZW4uY29t','eEBleGFtcGxlLmNvbQ'))
    def test_old_sent_record(self):
        key='Inbox/sales@dasexperten.com/sent/old.json'
        old={'box':'sales','sentAt':'2026-08-01T14:36:59Z','from':'sales@dasexperten.com'}
        result=normalize_record(old,key)
        self.assertEqual(result['timestamp'],old['sentAt'])
        self.assertEqual(result['direction'],'sent')
        with self.assertRaises(ValueError):normalize_record({**old,'box':'other'},key)
        with self.assertRaises(ValueError):normalize_record(old,key.replace('/sent/','/received/'))
    def test_roundtrip(self):
        raw,mid,date=compose(self.record,self.key,lambda k:bytes([0,255,1,2]))
        parsed=BytesParser(policy=policy.default).parsebytes(raw)
        self.assertEqual(str(parsed['Subject']),self.record['subject'])
        self.assertEqual(str(parsed['Message-ID']),mid)
        self.assertEqual(str(parsed['In-Reply-To']),'<parent@example.com>')
        self.assertEqual(date,1785595019)
        file=list(parsed.iter_attachments())[0]
        self.assertEqual(file.get_payload(decode=True),bytes([0,255,1,2]))
        self.assertEqual(file.get_filename(),'договор.pdf')
        self.assertEqual(str(file['Content-ID']),'<cid@example.com>')
        self.assertEqual(fingerprint(raw),fingerprint(parsed.as_bytes(policy=policy.default)))
        changed=raw.replace(b'parent@example.com',b'other@example.com')
        self.assertNotEqual(fingerprint(raw),fingerprint(changed))
        self.assertNotEqual(fingerprint(raw,True),fingerprint(changed,True))
        changed_id=raw.replace(b'original@example.com',b'new-id@example.com')
        self.assertEqual(fingerprint(raw,True),fingerprint(changed_id,True))
    def test_fail_closed(self):
        for change in [{'skipped':'too_large'}, {'key':'Other/secret'}, {'size':10}]:
            with self.subTest(change=change):
                record={**self.record,'attachments':[{**self.record['attachments'][0],**change}]}
                with self.assertRaises(ValueError):compose(record,self.key,lambda k:b'1234')
    def test_missing_id_is_stable(self):
        record={**self.record,'messageId':None}
        self.assertEqual(compose(record,self.key,lambda k:b'1234')[1],compose(record,self.key,lambda k:b'1234')[1])

    def test_folded_marker_with_replaced_invalid_id(self):
        raw,_,_=compose({**self.record,'messageId':'legacy-provider-uuid'},self.key,lambda k:b'1234')
        parsed=BytesParser(policy=policy.default).parsebytes(raw)
        parsed.replace_header('Message-ID','<valid-google-id@example.com>')
        restored=parsed.as_bytes(policy=policy.SMTP)
        self.assertRegex(restored,br'X-Das-ERP-Migration:[ \t]*\r\n[ \t]+')
        self.assertTrue(verified_content_equal(raw,restored,self.key))
        self.assertFalse(verified_content_equal(raw,restored,self.key+'wrong'))
        self.assertFalse(verified_content_equal(raw,restored.replace(b'parent@example.com',b'other@example.com'),self.key))
        self.assertFalse(verified_content_equal(raw,restored.replace(b'line 1',b'changed'),self.key))
        parsed.replace_header('X-Das-ERP-Migration','wrong')
        self.assertFalse(verified_content_equal(raw,parsed.as_bytes(),self.key))
        valid,_,_=compose(self.record,self.key,lambda k:b'1234')
        self.assertFalse(verified_content_equal(valid,restored,self.key),'A valid original Message-ID must remain identical')

if __name__=='__main__': unittest.main()

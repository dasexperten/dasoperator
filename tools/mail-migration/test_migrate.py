import unittest
from email import policy
from email.parser import BytesParser
from migrate import compose, fingerprint

class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.key='Inbox/sales@dasexperten.com/received/test.json'
        self.record={'address':'sales@dasexperten.com','direction':'received','timestamp':'2026-08-01T14:36:59.336Z','from':'Sender <sender@example.com>','to':['sales@dasexperten.com'],'cc':['cc@example.com'],'replyTo':'reply@example.com','subject':'Проверка 📬','text':'line 1\nline 2','html':'<p>Привет</p>','messageId':'<original@example.com>','threadId':'<parent@example.com>','attachments':[{'key':self.key[:-5]+'/att/0-file','size':4,'filename':'договор.pdf','mimeType':'application/pdf','inline':True,'contentId':'cid@example.com'}]}
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
    def test_fail_closed(self):
        for change in [{'skipped':'too_large'}, {'key':'Other/secret'}, {'size':10}]:
            with self.subTest(change=change):
                record={**self.record,'attachments':[{**self.record['attachments'][0],**change}]}
                with self.assertRaises(ValueError):compose(record,self.key,lambda k:b'1234')
    def test_missing_id_is_stable(self):
        record={**self.record,'messageId':None}
        self.assertEqual(compose(record,self.key,lambda k:b'1234')[1],compose(record,self.key,lambda k:b'1234')[1])

if __name__=='__main__': unittest.main()

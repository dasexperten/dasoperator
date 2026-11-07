import sqlite3
import unittest
from pathlib import Path

SQL = Path(__file__).with_name('repair-f4-inbox-attachments.sql').read_text()


class RepairAttachments(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript('''
          CREATE TABLE operations(id TEXT,partner_id TEXT,our_company_id TEXT,operation_type TEXT,
            notes TEXT,status TEXT,currency TEXT,total_amount REAL,operation_date INTEGER,reference TEXT,deleted_at INTEGER);
          CREATE TABLE invoice_inbox(id TEXT,created_operation_id TEXT,matched_partner_id TEXT,status TEXT,
            classification TEXT,extracted_currency TEXT,extracted_amount REAL,attachment_r2_key TEXT,
            extracted_invoice_date TEXT,extracted_invoice_no TEXT,extracted_vendor_name TEXT,deleted_at INTEGER);
          CREATE TABLE operation_attachments(id TEXT PRIMARY KEY,operation_id TEXT,direction TEXT,kind TEXT,
            doc_number TEXT,doc_date INTEGER,amount REAL,currency TEXT,issuer TEXT,file_url TEXT,
            parsed_from TEXT,source_ref_id TEXT,notes TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
          INSERT INTO operations VALUES('op','f4_lubertsy','dee','service','Invoice from invoice_inbox (cron) 14/218',
            'issued','RUB',100,1793836800,'LBR-20261105-14/218',NULL);
          INSERT INTO invoice_inbox VALUES('inv','op','f4_lubertsy','auto_created','service','RUB',100,
            'telegram_inbox/original.pdf','2026-11-05','14/218','F4',NULL);
        ''')

    def tearDown(self):
        self.db.close()

    def repair(self, now=1):
        self.db.execute(SQL, ('inv', now))
        return self.db.execute('SELECT changes()').fetchone()[0]

    def test_restores_file_once_without_changing_financial_or_resolution_fields(self):
        before = self.db.execute('SELECT * FROM operations').fetchall(), self.db.execute('SELECT * FROM invoice_inbox').fetchall()
        self.assertEqual(self.repair(1), 1)
        self.assertEqual(self.repair(2), 0)
        self.assertEqual(self.db.execute('SELECT file_url FROM operation_attachments').fetchone()[0],
                         'https://dasoperator-api.dasexperten.workers.dev/api/inbox/inv/file')
        self.assertEqual(before, (self.db.execute('SELECT * FROM operations').fetchall(), self.db.execute('SELECT * FROM invoice_inbox').fetchall()))

    def test_conflicting_money_partner_date_or_manual_rejection_are_not_repaired(self):
        for field, value in [('extracted_amount', 101), ('matched_partner_id', 'other'),
                             ('extracted_invoice_date', '2026-11-06'), ('status', 'manual_rejected')]:
            with self.subTest(field=field):
                original = self.db.execute(f'SELECT {field} FROM invoice_inbox').fetchone()[0]
                self.db.execute(f'UPDATE invoice_inbox SET {field}=?', (value,))
                self.assertEqual(self.repair(1), 0)
                self.db.execute(f'UPDATE invoice_inbox SET {field}=?', (original,))

    def test_existing_document_relation_is_preserved(self):
        self.db.execute("INSERT INTO operation_attachments(id,operation_id,parsed_from,source_ref_id) VALUES('manual','other','inbox','inv')")
        self.assertEqual(self.repair(1), 0)
        self.assertEqual(self.db.execute('SELECT operation_id FROM operation_attachments').fetchone()[0], 'other')


if __name__ == '__main__':
    unittest.main()

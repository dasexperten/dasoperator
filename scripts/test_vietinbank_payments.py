import sqlite3
import unittest
from pathlib import Path
from test_vietinbank_import_vat import TABLES, statements

ROOT = Path(__file__).resolve().parents[1]
SQLS = [
    (ROOT / 'db/migrations/0146_vietinbank_fedex.sql').read_text(),
    (ROOT / 'db/migrations/0147_atasia_supplier_advance.sql').read_text(),
]

class VietnamPaymentsTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        for name, columns in TABLES.items():
            if name == 'partners':
                columns += ', tax_id TEXT, inn TEXT'
            self.db.execute('CREATE TABLE ' + name + ' (' + columns + ')')
        self.db.execute('CREATE TABLE companies (id TEXT PRIMARY KEY)')
        self.db.execute("INSERT INTO companies VALUES ('dasean')")
        self.db.execute("INSERT INTO company_bank_accounts VALUES ('cba_dasean_vietin_vnd2','dasean','VND',NULL)")
        self.db.execute("INSERT INTO operations (id,reference,total_amount,currency) VALUES ('op_152b7275-809f-400d-9a86-4a0363c87b49','DEI-26092101',8383.11,'USD')")
        self.db.execute("INSERT INTO operations (id,reference,total_amount,currency) VALUES ('op_198986d0-0688-49fe-a404-cbe5724d12c2','WDAA-26091601',220.608,'USD')")
        self.db.execute("INSERT INTO operation_attachments (id,operation_id,doc_number,file_url) VALUES ('att_04ss_8980b7b66ee038d1b717','op_152b7275-809f-400d-9a86-4a0363c87b49','04/SS-HĐĐT concerning ATASIA 00014531','/existing-correction.pdf')")
        self.db.commit()

    def apply(self, sql):
        before = self.db.total_changes
        with self.db:
            for stmt in statements(sql):
                self.db.execute(stmt)
        return self.db.total_changes - before

    def test_posts_once_preserves_goods_and_distinguishes_supplier_receipt_from_bank_debit(self):
        original = self.db.execute('SELECT * FROM operations ORDER BY id').fetchall()
        evidence = self.db.execute('SELECT * FROM operation_attachments').fetchone()
        for sql in SQLS:
            self.assertEqual(self.apply(sql), 8)
            self.assertEqual(self.apply(sql), 0)
        self.assertEqual(self.db.execute("SELECT * FROM operations WHERE currency='USD' ORDER BY id").fetchall(), original)
        self.assertEqual(self.db.execute("SELECT * FROM operation_attachments WHERE id='att_04ss_8980b7b66ee038d1b717'").fetchone(), evidence)
        self.assertEqual(self.db.execute('SELECT amount,currency,date(executed_at,\'unixepoch\'),status FROM bank_transactions').fetchall(), [(4510397, 'VND', '2026-10-10', 'Executed')])
        self.assertEqual(self.db.execute('SELECT b.amount,p.amount,o.total_amount,o.operation_type FROM bank_transactions b JOIN payments p ON p.id=b.matched_payment_id JOIN operations o ON o.id=b.matched_operation_id').fetchone(), (4510397,4510397,4510397,'tax'))
        self.assertEqual(self.db.execute("SELECT p.amount,p.type,date(p.payment_date,'unixepoch'),o.total_amount,o.operation_type,o.vat_rate,date(o.operation_date,'unixepoch') FROM payments p JOIN operations o ON o.id=p.operation_id WHERE p.id='pay_at_1031926P26031973'").fetchone(), (9017501,'advance','2026-09-26',9017501,'service',8,'2026-09-28'))
        self.assertEqual(self.db.execute('SELECT status,signed_date FROM contracts').fetchall(), [('draft',None),('draft',None)])
        self.assertEqual(self.db.execute("SELECT count(*) FROM operation_attachments WHERE file_url LIKE '/api/attachment-files/%'").fetchone()[0],4)
        self.assertEqual(self.db.execute("SELECT json_extract(raw_payload,'$.execution_time_precision'),json_extract(raw_payload,'$.duty_tax_vnd'),json_extract(raw_payload,'$.customs_fee_vnd') FROM bank_transactions").fetchone(),('date_only',4500397,10000))
        self.assertEqual(self.db.execute("SELECT count(*) FROM bank_transactions WHERE amount=22000").fetchone()[0],0)

    def test_other_id_duplicate_or_soft_deleted_payment_blocks(self):
        for i,amount in enumerate((4510397,9017501)):
            for deleted in (None,1793200000):
                with self.subTest(amount=amount,deleted=deleted):
                    self.db.execute("INSERT INTO bank_transactions (id,company_bank_account_id,external_id,amount,currency,executed_at,deleted_at) VALUES ('existing','cba_dasean_vietin_vnd2','another-reference',?,'VND',1,?)",(amount,deleted))
                    self.db.commit()
                    with self.assertRaises(sqlite3.DatabaseError):self.apply(SQLS[i])
                    self.assertEqual(self.db.execute('SELECT count(*) FROM payments').fetchone()[0],0)
                    self.db.execute("DELETE FROM bank_transactions WHERE id='existing'")
                    self.db.commit()

    def test_existing_target_id_with_wrong_or_null_financial_value_blocks(self):
        for i,op in enumerate(('op_vn_fedex_928A26A0FMWQ51NL','op_vn_atasia_00014531')):
            self.db.execute("INSERT INTO operations (id,total_amount,currency) VALUES (?,NULL,'VND')",(op,))
            self.db.commit()
            with self.assertRaises(sqlite3.DatabaseError):self.apply(SQLS[i])
            self.assertEqual(self.db.execute('SELECT count(*) FROM partners').fetchone()[0],0)
            self.db.execute('DELETE FROM operations WHERE id=?',(op,))
            self.db.commit()

    def test_late_failure_rolls_back_all_new_rows(self):
        self.db.execute("CREATE TRIGGER fail_evidence BEFORE INSERT ON operation_attachments BEGIN SELECT RAISE(ABORT,'test evidence failure'); END")
        self.db.commit()
        for sql in SQLS:
            with self.assertRaises(sqlite3.DatabaseError):self.apply(sql)
            self.assertEqual(self.db.execute('SELECT count(*) FROM partners').fetchone()[0],0)
            self.assertEqual(self.db.execute('SELECT count(*) FROM payments').fetchone()[0],0)
            self.assertEqual(self.db.execute('SELECT count(*) FROM bank_transactions').fetchone()[0],0)

if __name__ == '__main__':unittest.main()

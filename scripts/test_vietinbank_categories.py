import sqlite3
import unittest
from pathlib import Path
from test_vietinbank_import_vat import statements

SQL=(Path(__file__).resolve().parents[1]/'db/migrations/0148_vietnam_finance_categories.sql').read_text()
class VietnamCategoryTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.executescript('''
        CREATE TABLE partners(id TEXT,deleted_at INTEGER,partner_type TEXT,kind TEXT,partner_subtype TEXT,updated_at INTEGER);
        CREATE TABLE operations(id TEXT,deleted_at INTEGER,currency TEXT,operation_track TEXT,operation_type TEXT,total_amount INTEGER,vat_rate INTEGER,service_subtype TEXT,notes TEXT,updated_at INTEGER);
        CREATE TABLE finance_categories(id TEXT,code TEXT,deleted_at INTEGER);
        CREATE TABLE bank_transactions(id TEXT,deleted_at INTEGER,currency TEXT,status TEXT,amount INTEGER,matched_operation_id TEXT,matched_payment_id TEXT,suggested_category_id TEXT,updated_at INTEGER);
        INSERT INTO partners VALUES('at-asia-hcm',NULL,'supplier','service_provider',NULL,1),('fedex-express-vietnam',NULL,'supplier','service_provider',NULL,1);
        INSERT INTO operations VALUES('op_vn_atasia_00014531',NULL,'VND','service','service',9017501,8,NULL,'original',1),('op_vn_fedex_928A26A0FMWQ51NL',NULL,'VND','service','tax',4510397,0,NULL,'original',1),('op_vn_import_vat_NNS26102607904',NULL,'VND','service','tax',17249087,0,NULL,'original',1);
        INSERT INTO finance_categories VALUES('fc_tax_government','tax_government',NULL);
        INSERT INTO bank_transactions VALUES('bt_vietin_928A26A0FMWQ51NL',NULL,'VND','Executed',4510397,'op_vn_fedex_928A26A0FMWQ51NL','pay_vietin_928A26A0FMWQ51NL',NULL,1),('bt_vietin_NNS26102607904',NULL,'VND','Executed',17249087,'op_vn_import_vat_NNS26102607904','pay_vietin_NNS26102607904',NULL,1);
        ''')
    def apply(self):
        before=self.db.total_changes
        with self.db:
            for stmt in statements(SQL):self.db.execute(stmt)
        return self.db.total_changes-before
    def test_exact_metadata_changes_once_preserves_amounts_and_links(self):
        banks=self.db.execute('SELECT id,status,amount,matched_operation_id,matched_payment_id FROM bank_transactions').fetchall()
        amounts=self.db.execute('SELECT id,total_amount,vat_rate,operation_type FROM operations').fetchall()
        self.assertEqual(self.apply(),7)
        self.assertEqual(self.apply(),0)
        self.assertEqual(self.db.execute('SELECT id,status,amount,matched_operation_id,matched_payment_id FROM bank_transactions').fetchall(),banks)
        self.assertEqual(self.db.execute('SELECT id,total_amount,vat_rate,operation_type FROM operations').fetchall(),amounts)
        self.assertEqual(self.db.execute('SELECT service_subtype FROM operations').fetchall(),[('logistics_local_charges',),('customs_duty_tax_reimbursement',),('import_vat',)])
        self.assertEqual(self.db.execute('SELECT partner_subtype FROM partners').fetchall(),[('logistics',),('logistics',)])
        note=self.db.execute("SELECT notes FROM operations WHERE id='op_vn_atasia_00014531'").fetchone()[0]
        self.assertTrue(note.startswith('original\n'))
        self.assertEqual(note.count('Invoice line breakdown'),1)
        self.assertIn('Totals 8349538/667963/9017501.',note)
    def test_wrong_amount_or_existing_different_category_blocks_all_writes(self):
        self.db.execute("UPDATE bank_transactions SET amount=451039700 WHERE id='bt_vietin_928A26A0FMWQ51NL'")
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):self.apply()
        self.assertEqual(self.db.execute('SELECT count(*) FROM partners WHERE partner_subtype IS NOT NULL').fetchone()[0],0)
    def test_late_failure_rolls_back_metadata(self):
        self.db.execute("CREATE TRIGGER fail_bank BEFORE UPDATE ON bank_transactions BEGIN SELECT RAISE(ABORT,'test'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):self.apply()
        self.assertEqual(self.db.execute('SELECT count(*) FROM operations WHERE service_subtype IS NOT NULL').fetchone()[0],0)

if __name__=='__main__':unittest.main()

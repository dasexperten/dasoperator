import sqlite3
import unittest
from pathlib import Path

SQL = (Path(__file__).resolve().parents[1] / 'db/migrations/0145_vietinbank_import_vat.sql').read_text()
TABLES = {
    'company_bank_accounts': 'id TEXT PRIMARY KEY, company_id TEXT, currency TEXT, deleted_at INTEGER',
    'partners': 'id TEXT PRIMARY KEY, trade_name TEXT, legal_name TEXT, country TEXT, currency TEXT, status TEXT, partner_type TEXT, kind TEXT, notes TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER',
    'contracts': 'id TEXT PRIMARY KEY, contract_no TEXT UNIQUE, partner_id TEXT REFERENCES partners(id), our_company_id TEXT, currency TEXT, status TEXT, agreement_type TEXT, notes TEXT, signed_date INTEGER, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER',
    'operations': 'id TEXT PRIMARY KEY, reference TEXT, operation_date INTEGER, operation_type TEXT, operation_track TEXT, partner_id TEXT REFERENCES partners(id), our_company_id TEXT, contract_id TEXT REFERENCES contracts(id), status TEXT, currency TEXT, total_amount INTEGER, vat_rate INTEGER, notes TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER',
    'payments': 'id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), contract_id TEXT NOT NULL REFERENCES contracts(id), operation_id TEXT REFERENCES operations(id), amount INTEGER NOT NULL CHECK(amount>0), currency TEXT, payment_date INTEGER, type TEXT, direction TEXT, notes TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER',
    'bank_transactions': 'id TEXT PRIMARY KEY, company_bank_account_id TEXT REFERENCES company_bank_accounts(id), external_id TEXT, external_doc_number TEXT, direction TEXT, status TEXT, amount INTEGER, currency TEXT, executed_at INTEGER, created_at_bank INTEGER, contragent_name TEXT, contragent_account TEXT, contragent_bank_name TEXT, payment_purpose TEXT, matched_payment_id TEXT REFERENCES payments(id), matched_operation_id TEXT REFERENCES operations(id), match_method TEXT, matched_at INTEGER, matched_by TEXT, raw_payload TEXT, source_type TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, UNIQUE(company_bank_account_id,external_id)',
    'operation_attachments': 'id TEXT PRIMARY KEY, operation_id TEXT REFERENCES operations(id), direction TEXT, kind TEXT, doc_number TEXT, doc_date INTEGER, amount REAL, currency TEXT, issuer TEXT, file_url TEXT, parsed_from TEXT, source_ref_id TEXT, notes TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER',
}


def statements(sql):
    pending = ''
    for line in sql.splitlines(True):
        pending += line
        if sqlite3.complete_statement(pending):
            yield pending
            pending = ''
    assert not pending.strip()


class VietinImportVatTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        for name, columns in TABLES.items():
            self.db.execute('CREATE TABLE ' + name + ' (' + columns + ')')
        self.db.execute("INSERT INTO company_bank_accounts VALUES ('cba_dasean_vietin_vnd2','dasean','VND',NULL)")
        self.db.execute("INSERT INTO operations (id,reference,total_amount,currency) VALUES ('op_152b7275-809f-400d-9a86-4a0363c87b49','DEI-26092101',8383.11,'USD')")
        self.db.execute("INSERT INTO operation_attachments (id,operation_id,doc_number,doc_date,amount,currency,file_url) VALUES ('att_customs_NNS26102607904','op_152b7275-809f-400d-9a86-4a0363c87b49','NNS26102607904',1793016000,17249087,'VND','/existing-bank-proof.png')")
        self.db.commit()

    def apply(self):
        before = self.db.total_changes
        with self.db:
            for stmt in statements(SQL):
                self.db.execute(stmt)
        return self.db.total_changes - before

    def test_posts_separate_tax_once_with_whole_vnd_and_existing_evidence(self):
        source = self.db.execute("SELECT * FROM operations WHERE reference='DEI-26092101'").fetchone()
        evidence = self.db.execute("SELECT * FROM operation_attachments").fetchone()
        self.assertEqual(self.apply(), 6)
        self.assertEqual(self.apply(), 0)
        self.assertEqual(self.db.execute("SELECT * FROM operations WHERE reference='DEI-26092101'").fetchone(), source)
        self.assertEqual(self.db.execute("SELECT * FROM operation_attachments WHERE id='att_customs_NNS26102607904'").fetchone(), evidence)
        row = self.db.execute('SELECT b.amount,p.amount,o.total_amount,b.currency,p.currency,o.currency,o.operation_type,o.our_company_id FROM bank_transactions b JOIN payments p ON p.id=b.matched_payment_id JOIN operations o ON o.id=b.matched_operation_id').fetchone()
        self.assertEqual(row, (17249087,17249087,17249087,'VND','VND','VND','tax','dasean'))
        self.assertEqual(self.db.execute('SELECT status,signed_date,agreement_type FROM contracts').fetchone(), ('draft',None,'other'))
        self.assertEqual(self.db.execute("SELECT json_extract(raw_payload,'$.execution_time_precision') FROM bank_transactions").fetchone()[0], 'date_only')
        self.assertEqual(self.db.execute('SELECT count(DISTINCT file_url) FROM operation_attachments').fetchone()[0], 1)

    def test_duplicate_by_reference_or_amount_including_deleted_blocks_every_write(self):
        for deleted in (None, 1793200000):
            with self.subTest(deleted=deleted):
                self.db.execute("INSERT INTO bank_transactions (id,company_bank_account_id,external_id,amount,currency,executed_at,deleted_at) VALUES ('different-id','cba_dasean_vietin_vnd2','other-reference',17249087,'VND',1793016000,?)", (deleted,))
                self.db.commit()
                with self.assertRaises(sqlite3.DatabaseError):
                    self.apply()
                self.assertEqual(self.db.execute('SELECT count(*) FROM partners').fetchone()[0], 0)
                self.assertEqual(self.db.execute('SELECT count(*) FROM payments').fetchone()[0], 0)
                self.db.execute("DELETE FROM bank_transactions WHERE id='different-id'")
                self.db.commit()

    def test_wrong_source_amount_blocks_posting(self):
        self.db.execute('UPDATE operation_attachments SET amount=1724908700')
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            self.apply()
        self.assertEqual(self.db.execute('SELECT count(*) FROM payments').fetchone()[0], 0)

    def test_late_failure_rolls_back_the_entire_batch(self):
        self.db.execute("CREATE TRIGGER fail_attachment BEFORE INSERT ON operation_attachments WHEN NEW.id='att_vn_import_vat_NNS26102607904' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            self.apply()
        self.assertEqual(self.db.execute('SELECT count(*) FROM partners').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM bank_transactions').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()

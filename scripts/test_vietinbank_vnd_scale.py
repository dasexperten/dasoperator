import json
import sqlite3
import unittest
from pathlib import Path

MIGRATION = (Path(__file__).resolve().parents[1] / 'db/migrations/0144_vietinbank_vnd_scale.sql').read_text()
SOURCE = 'manual transcription of authenticated VietinBank eFAST transaction statistics and payment detail'
CASES = [('1031926J27304307', 2862000), ('1031926J27304087', 24750000)]


class VietinBankScaleTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('CREATE TABLE bank_transactions (id TEXT PRIMARY KEY, currency TEXT, amount INTEGER, raw_payload TEXT, matched_payment_id TEXT, matched_operation_id TEXT)')
        for number, amount in CASES:
            payload = dict(source=SOURCE, transaction_number=number, amount_vnd=amount,
                           bank_charge_vnd=22000, status='Successful', recorded_by='justina-timber')
            for suffix, value in [('', amount), ('_fee', 22000)]:
                evidence = dict(payload)
                if suffix:
                    evidence['component'] = 'bank_fee'
                    evidence['separate_bank_transaction_number'] = None
                self.db.execute('INSERT INTO bank_transactions VALUES (?, ?, ?, ?, ?, ?)',
                                ('bt_vietin_' + number + suffix, 'VND', value * 100,
                                 json.dumps(evidence), 'payment-link' if not suffix else None,
                                 'operation-link' if not suffix else None))

    def test_four_owner_rows_corrected_once_and_links_preserved(self):
        before = self.db.execute('SELECT id, raw_payload, matched_payment_id, matched_operation_id FROM bank_transactions ORDER BY id').fetchall()
        self.db.executescript(MIGRATION)
        self.assertEqual(self.db.execute('SELECT changes()').fetchone()[0], 4)
        self.assertEqual(self.db.execute('SELECT SUM(amount) FROM bank_transactions').fetchone()[0], 27656000)
        self.assertEqual(self.db.execute('SELECT id, raw_payload, matched_payment_id, matched_operation_id FROM bank_transactions ORDER BY id').fetchall(), before)
        self.db.executescript(MIGRATION)
        self.assertEqual(self.db.execute('SELECT changes()').fetchone()[0], 0)

    def test_changed_or_unproven_rows_are_never_rescaled(self):
        row = self.db.execute('SELECT * FROM bank_transactions LIMIT 1').fetchone()
        cases = [
            {'id': 'unrelated_vnd_payment'},
            {'currency': 'USD'},
            {'amount': row[2] + 1},
            {'raw_payload': '{}'},
            {'raw_payload': 'broken JSON'},
        ]
        for key, value in [('amount_vnd', 1), ('transaction_number', 'other'),
                           ('status', 'Pending'), ('recorded_by', 'other'), ('source', 'unverified')]:
            evidence = json.loads(row[3])
            evidence[key] = value
            cases.append({'raw_payload': json.dumps(evidence)})
        for overrides in cases:
            with self.subTest(overrides=overrides):
                values = dict(zip(['id', 'currency', 'amount', 'raw_payload', 'matched_payment_id', 'matched_operation_id'], row))
                values.update(overrides)
                self.db.execute('DELETE FROM bank_transactions')
                self.db.execute('INSERT INTO bank_transactions VALUES (?, ?, ?, ?, ?, ?)', tuple(values.values()))
                self.db.executescript(MIGRATION)
                self.assertEqual(self.db.execute('SELECT changes()').fetchone()[0], 0)
                self.assertEqual(self.db.execute('SELECT * FROM bank_transactions').fetchone(), tuple(values.values()))


if __name__ == '__main__':
    unittest.main()

import pathlib
import subprocess
import tempfile
import unittest

INSTALLER = pathlib.Path(__file__).with_name('vps-install-ozon-scraper.sh')
FIXTURE = ('OZON_COOKIES=session=fixture-cookie\n'
           'INGEST_SECRET=fixture-' + 'x' * 40 + '\n'
           'WORKER_URL=https://dasoperator-api.dasexperten.workers.dev/api/marketplaces/ozon/portal-ingest\n')


class InstallerCredentials(unittest.TestCase):
    def validate(self, content, mode=0o600):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'private.env'
            path.write_text(content)
            path.chmod(mode)
            result = subprocess.run(['bash', str(INSTALLER), '--check-env', str(path)],
                                    capture_output=True, text=True)
            self.assertNotIn('fixture-cookie', result.stdout + result.stderr)
            self.assertNotIn('fixture-' + 'x' * 40, result.stdout + result.stderr)
            self.assertEqual(list(pathlib.Path(folder).iterdir()), [path])
            return result

    def test_explicit_private_input_can_be_validated_without_installing(self):
        self.assertEqual(self.validate(FIXTURE).returncode, 0)

    def test_missing_input_fails_before_installation(self):
        result = subprocess.run(['bash', str(INSTALLER)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 64)

    def test_public_credentials_are_rejected(self):
        self.assertNotEqual(self.validate(FIXTURE, 0o644).returncode, 0)

    def test_missing_and_duplicate_credentials_are_rejected(self):
        self.assertNotEqual(self.validate(FIXTURE.replace('OZON_COOKIES=session=fixture-cookie\n', '')).returncode, 0)
        self.assertNotEqual(self.validate(FIXTURE + 'INGEST_SECRET=duplicate\n').returncode, 0)

    def test_credential_forwarding_to_another_host_is_rejected(self):
        self.assertNotEqual(self.validate(FIXTURE.replace('dasoperator-api.dasexperten.workers.dev', 'example.invalid')).returncode, 0)

    def test_installer_contains_no_embedded_credentials(self):
        source = INSTALLER.read_text()
        self.assertNotIn("cat > .env <<", source)
        self.assertNotRegex(source, r'(?m)^(OZON_COOKIES|INGEST_SECRET)=')
        self.assertNotRegex(source, r'\b[a-f0-9]{64}\b')
        self.assertEqual(subprocess.run(['bash', '-n', str(INSTALLER)]).returncode, 0)


if __name__ == '__main__':
    unittest.main()

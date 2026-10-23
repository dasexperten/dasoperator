#!/bin/sh
# Run from a verified git-archive release. This prepares but never activates it.
set -eu
release_sha=${1:?Pass the pushed main SHA}
case "$release_sha" in *[!0-9a-f]*|'') exit 2;; esac
[ "${#release_sha}" -eq 40 ]
[ "$(id -u)" -eq 0 ]
release_dir="/opt/dasoperator-erp-clock/releases/$release_sha"
[ "$(pwd -P)" = "$release_dir" ]
[ -f /etc/dasoperator-erp-clock.env ]
[ "$(stat -c %a /etc/dasoperator-erp-clock.env)" = 600 ]
[ "$(stat -c %U /etc/dasoperator-erp-clock.env)" = root ]
command -v curl >/dev/null
python3 -m unittest discover -s . -p 'test_*.py'
if ! id dasoperator-clock >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin dasoperator-clock
fi
chown -R root:root "$release_dir"
chmod 755 "$release_dir"
chmod 644 clock.py test_clock.py dasoperator-erp-clock.service
install -m 644 dasoperator-erp-clock.service /etc/systemd/system/dasoperator-erp-clock.service
ln -sfn "$release_dir" /opt/dasoperator-erp-clock/current
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/dasoperator-erp-clock.service
echo "Prepared release $release_sha; service not started by installer."

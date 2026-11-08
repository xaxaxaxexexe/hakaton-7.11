#!/usr/bin/env bash
# Run from the repository root after tests and `npm run build --prefix apps/web`.
# Requires SSH access, /opt/zal/venv and the private /etc/zal/zal.env on the host.
set -euo pipefail
host="${1:?Usage: deploy/release.sh user@host}"
ssh_cmd() {
  if [ -n "${ZAL_SSH_PASSWORD_FILE:-}" ]; then sshpass -f "$ZAL_SSH_PASSWORD_FILE" ssh "$@"; else ssh "$@"; fi
}
scp_cmd() {
  if [ -n "${ZAL_SSH_PASSWORD_FILE:-}" ]; then sshpass -f "$ZAL_SSH_PASSWORD_FILE" scp "$@"; else scp "$@"; fi
}
release="$(date -u +%Y%m%dT%H%M%SZ)"
revision="$(git rev-parse HEAD)"
bundle="$(mktemp -t zal-release.XXXXXX)"
trap 'rm -f "$bundle"' EXIT
COPYFILE_DISABLE=1 tar --exclude=__pycache__ --exclude='*.pyc' -czf "$bundle" \
  apps/api/app apps/api/requirements.txt contracts/fixtures apps/web/dist deploy/zal.service
scp_cmd "$bundle" "$host:/opt/zal/releases/$release.tar.gz"
ssh_cmd "$host" bash -s -- "$release" "$revision" <<'REMOTE'
set -euo pipefail
release="$1"
revision="$2"
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
previous="$(readlink -f /opt/zal/current || true)"
test -s /etc/zal/zal.env
mkdir -p "/opt/zal/releases/$release"
tar -xzf "/opt/zal/releases/$release.tar.gz" -C "/opt/zal/releases/$release"
printf '%s\n' "$revision" > "/opt/zal/releases/$release/REVISION"
/opt/zal/venv/bin/pip install -r "/opt/zal/releases/$release/apps/api/requirements.txt" --quiet
ln -sfn "/opt/zal/releases/$release" /opt/zal/current.next
mv -Tf /opt/zal/current.next /opt/zal/current
install -m 644 /opt/zal/current/deploy/zal.service /etc/systemd/system/zal.service
systemctl daemon-reload
systemctl enable zal.service
systemctl restart zal.service
for attempt in {1..12}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:8100/api/v1/health; then
    printf '\nRelease %s ready. Database preserved at /var/lib/zal/zal.db\n' "$release"
    exit 0
  fi
  sleep 1
done
if [ -n "$previous" ] && [ -d "$previous" ]; then
  ln -sfn "$previous" /opt/zal/current.next
  mv -Tf /opt/zal/current.next /opt/zal/current
  systemctl restart zal.service
  printf 'Health failed; previous code restored.\n' >&2
fi
exit 1
REMOTE

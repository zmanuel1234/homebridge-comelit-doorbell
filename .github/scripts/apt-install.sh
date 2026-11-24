#!/usr/bin/env bash
# Installs the system packages listed in .github/apt-packages (one per line, # for comments), for
# CI and the release build. Ubuntu's package mirror, the runner's own apt jobs and the manual-page
# index can stall an install for many minutes: each attempt is capped and retried instead.
set -euo pipefail
list="${1:-.github/apt-packages}"
mapfile -t packages < <(grep -Ev '^[[:space:]]*(#|$)' "$list" | tr -d '[:space:]' | grep -v '^$' || true)
if [ "${#packages[@]}" -eq 0 ]; then
  echo "No packages listed in $list"
  exit 0
fi
# Rebuilding the manual-page index after installing is slow on the runners and not needed here.
echo 'man-db man-db/auto-update boolean false' | sudo debconf-set-selections
sudo rm -f /var/lib/man-db/auto-update
# A stalled download is dropped after 30 s and tried again; the runner's own apt jobs (which hold
# the lock at start-up) are waited for up to 2 minutes rather than for ever.
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=120)
export DEBIAN_FRONTEND=noninteractive
for attempt in 1 2 3; do
  echo "::group::apt attempt $attempt: ${packages[*]}"
  # After a stalled attempt was stopped: finish whatever it left half-installed.
  sudo dpkg --configure -a || true
  if timeout 90 sudo -E apt-get "${opts[@]}" update -q &&
    timeout 180 sudo -E apt-get "${opts[@]}" install -y -q --no-install-recommends "${packages[@]}"; then
    echo "::endgroup::"
    exit 0
  fi
  echo "::endgroup::"
  echo "::warning::Installing ${packages[*]} failed or stalled (attempt $attempt of 3); trying again"
  sleep 10
done
echo "::error::Could not install ${packages[*]} after 3 attempts"
exit 1

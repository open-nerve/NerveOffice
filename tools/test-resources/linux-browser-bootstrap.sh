#!/bin/sh
# Only executed inside the registered Linux container. No host package changes.
set -eu
mkdir -p /owned/tmp /owned/npm-cache /owned/cache /owned/pnpm
if ! command -v python3 >/dev/null 2>&1 || ! command -v lsof >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 lsof
fi
exec python3 -B /owned/source/tools/test-resources/linux_browser_guest.py

#!/bin/sh
# Railway mounts a volume owned by root, and the app runs as the unprivileged `erp` user, so
# without this the first attachment upload fails with EACCES on a directory the app cannot
# create. The container therefore starts as root only long enough to make the storage
# directory writable, then drops privileges for everything that follows — the application
# itself never runs as root.
set -e

if [ -n "$STORAGE_LOCAL_DIR" ]; then
  mkdir -p "$STORAGE_LOCAL_DIR"
  chown -R erp:erp "$STORAGE_LOCAL_DIR"
fi

exec gosu erp "$@"

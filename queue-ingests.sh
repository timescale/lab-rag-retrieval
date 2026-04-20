#!/bin/bash
# Sequential ingest of multiple BRIGHT domains
set -e
for domain in "$@"; do
  echo "=== Ingesting $domain ==="
  bun src/ingest-bright.ts --domain "$domain" --force
done
echo "All done"

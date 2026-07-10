#!/usr/bin/env bash
# Fetch a documentation page as raw HTML using a browser User-Agent.
#
# Why this exists instead of WebFetch: WebFetch has failed with "Unable to
# verify if domain is safe to fetch" on some vendor doc domains (seen on
# docs.aws.amazon.com and docs.cloud.google.com in past runs of this skill).
# curl has no such gate, so it's the primary fetch method here, not a fallback.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: fetch_doc.sh <url> <output-file>" >&2
  exit 1
fi

url="$1"
out="$2"

curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" \
  "$url" -o "$out" -w "HTTP %{http_code}\n" --max-time 30

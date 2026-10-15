#!/usr/bin/env python3
"""Refresh the Model Garden catalog cache (vertex_all_models.json) via the
service-account REST path and report which (publisher, model) pairs are new.
Verifies the SA credential at the same time (first token mint + first list call).
"""
import json
import sys

import requests

sys.path.insert(0, ".")
import build_vertex_matrix as bvm  # noqa: E402

SA = "sa.json"
with open(SA, encoding="utf-8") as f:
    project = json.load(f)["project_id"]

token_fn = bvm.service_account_token_fn(SA)
print(f"[auth] using service account (project {project})", file=sys.stderr)

fresh = bvm.fetch_catalog_rest(requests.Session(), token_fn, project, timeout=180)

try:
    with open("vertex_all_models.json", encoding="utf-8") as f:
        old = json.load(f)
except FileNotFoundError:
    old = []


def key_of(entry):
    m = bvm.NAME_RE.search(entry.get("name", ""))
    return (m.group(1), m.group(2)) if m else None


old_keys = {k for k in (key_of(e) for e in old) if k}
added = []
for e in fresh:
    k = key_of(e)
    if k and k not in old_keys and k not in [a[0] for a in added]:
        added.append((k, e.get("launchStage", ""), e.get("displayName") or k[1]))

with open("vertex_all_models.json", "w", encoding="utf-8") as f:
    json.dump(fresh, f, indent=2, ensure_ascii=False)

print(f"[catalog] old={len(old)} fresh={len(fresh)} new (publisher|model)={len(added)}", file=sys.stderr)
for k, stage, disp in added:
    print(f"  + {k[0]}|{k[1]} [{stage}] {disp}", file=sys.stderr)

import importlib.util
import json
import sys

import requests

spec = importlib.util.spec_from_file_location("bvm", "build_vertex_matrix.py")
bvm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bvm)

sa_path = sys.argv[1] if len(sys.argv) > 1 else "sa.json"
out_path = sys.argv[2] if len(sys.argv) > 2 else "vertex_all_models.new.json"

token_fn = bvm.service_account_token_fn(sa_path)
with requests.Session() as session:
    catalog = bvm.fetch_catalog_rest(session, token_fn, "zabqtest", 30)

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(catalog, fh)
print(f"wrote {len(catalog)} entries -> {out_path}", file=sys.stderr)

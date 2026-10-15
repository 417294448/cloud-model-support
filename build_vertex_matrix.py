#!/usr/bin/env python3
"""Build a GCP Vertex AI Model Garden model x region availability matrix.

`gcloud ai model-garden models list` has no --region flag; the catalog it
returns is global. Per-region availability instead has to be probed via the
regional REST endpoint `GET https://{region}-aiplatform.googleapis.com/v1/
publishers/{publisher}/models/{model_id}` (200 = available, 404 = not
available in that region, 403 = exists but gated behind an access grant/EULA
for this project, unrelated to region).

Output is a single JSON provider object matching the schema already embedded
in index.html's #data script (see the "aws"/"azure" provider entries), ready
to splice into the page's `providers` array.

Authentication is via `gcloud` by default. Pass `--service-account <key.json>`
to run without gcloud: the catalog is listed through the ModelGardenService
REST API and the access token is minted from the service-account key via
`google-auth`, so the only external dependencies are `requests` + `google-auth`.
"""

import argparse
import concurrent.futures
import datetime
import json
import re
import shutil
import subprocess
import sys
import time

import requests

GCLOUD = shutil.which("gcloud")

# code -> (display name, geographic group)
REGION_META = {
    "us-central1": ("Iowa", "Americas"),
    "us-east1": ("South Carolina", "Americas"),
    "us-east4": ("Northern Virginia", "Americas"),
    "us-east5": ("Columbus", "Americas"),
    "us-south1": ("Dallas", "Americas"),
    "us-west1": ("Oregon", "Americas"),
    "us-west4": ("Las Vegas", "Americas"),
    "northamerica-northeast1": ("Montreal", "Americas"),
    "northamerica-northeast2": ("Toronto", "Americas"),
    "southamerica-east1": ("Sao Paulo", "Americas"),
    "southamerica-west1": ("Santiago", "Americas"),
    "europe-west1": ("Belgium", "Europe"),
    "europe-west2": ("London", "Europe"),
    "europe-west3": ("Frankfurt", "Europe"),
    "europe-west4": ("Netherlands", "Europe"),
    "europe-west6": ("Zurich", "Europe"),
    "europe-west8": ("Milan", "Europe"),
    "europe-west9": ("Paris", "Europe"),
    "europe-west12": ("Turin", "Europe"),
    "europe-central2": ("Warsaw", "Europe"),
    "europe-north1": ("Finland", "Europe"),
    "europe-southwest1": ("Madrid", "Europe"),
    "asia-east1": ("Taiwan", "Asia Pacific"),
    "asia-east2": ("Hong Kong", "Asia Pacific"),
    "asia-northeast1": ("Tokyo", "Asia Pacific"),
    "asia-northeast2": ("Osaka", "Asia Pacific"),
    "asia-northeast3": ("Seoul", "Asia Pacific"),
    "asia-south1": ("Mumbai", "Asia Pacific"),
    "asia-south2": ("Delhi", "Asia Pacific"),
    "asia-southeast1": ("Singapore", "Asia Pacific"),
    "asia-southeast2": ("Jakarta", "Asia Pacific"),
    "australia-southeast1": ("Sydney", "Asia Pacific"),
    "australia-southeast2": ("Melbourne", "Asia Pacific"),
    "me-central1": ("Doha", "Middle East"),
    "me-central2": ("Dammam", "Middle East"),
    "me-west1": ("Tel Aviv", "Middle East"),
}

PUBLISHER_DISPLAY = {
    "google": "Google",
    "anthropic": "Anthropic",
    "meta": "Meta",
    "mistralai": "Mistral AI",
    "mistral-ai": "Mistral AI",
    "ai21": "AI21 Labs",
    "cohere": "Cohere",
    "deepseek-ai": "DeepSeek",
    "qwen": "Qwen",
    "openai": "OpenAI",
    "moonshotai": "Moonshot AI",
    "xai": "xAI",
    "nvidia": "NVIDIA",
    "writer": "Writer",
    "stability-ai": "Stability AI",
    "zai-org": "Z.AI",
    "salesforce": "Salesforce",
    "microsoft": "Microsoft",
    "baai": "BAAI",
    "minimaxai": "MiniMax",
}

NAME_RE = re.compile(r"publishers/([^/]+)/models/([^/@]+)(?:@(.+))?$")
LAUNCH_STAGE_RANK = {"GA": 3, "PUBLIC_PREVIEW": 2, "PRIVATE_PREVIEW": 1, "EXPERIMENTAL": 0}


def publisher_display(pub):
    if pub in PUBLISHER_DISPLAY:
        return PUBLISHER_DISPLAY[pub]
    return pub.replace("-", " ").replace("_", " ").title()


def run_gcloud(args, timeout):
    if not GCLOUD:
        raise SystemExit("gcloud CLI not found on PATH. Install/authenticate the Google Cloud SDK first.")
    try:
        return subprocess.run([GCLOUD, *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise SystemExit("gcloud CLI not found on PATH. Install/authenticate the Google Cloud SDK first.")


def fetch_catalog(billing_project, timeout):
    print("Fetching global Model Garden catalog...", file=sys.stderr)
    result = run_gcloud(
        [
            "ai", "model-garden", "models", "list",
            f"--billing-project={billing_project}",
            "--format=json",
            "--limit=unlimited",
        ],
        timeout=timeout,
    )
    if result.returncode != 0:
        raise SystemExit(f"Failed to list Model Garden catalog:\n{result.stderr}")
    return json.loads(result.stdout or "[]")


def fetch_catalog_rest(session, token_fn, project, timeout):
    """List the catalog via the ModelGardenService REST API (no gcloud).

    Mirrors `gcloud ai model-garden models list` exactly (verified against the
    SDK's own client): the parent is the wildcard `publishers/*`, the endpoint
    is the *regional* `us-central1-aiplatform.googleapis.com` host (the global
    `aiplatform.googleapis.com` host only returns managed-API models), and the
    request carries `filter=is_hf_wildcard(false)` plus `listAllVersions=True`.
    Returns entries shaped like `gcloud ai model-garden models list` output --
    the two sources expose the same fields (name/versionId/launchStage/
    supportedActions) -- so the result feeds `dedupe_models` unchanged.
    """
    print("Fetching Model Garden catalog via REST (publishers/* wildcard)...", file=sys.stderr)
    entries = []
    page_token = None
    while True:
        params = {
            "pageSize": 100,
            "listAllVersions": True,
            "filter": "is_hf_wildcard(false)",
        }
        if page_token:
            params["pageToken"] = page_token
        url = "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/*/models"
        headers = {
            "Authorization": f"Bearer {token_fn(timeout)}",
            "x-goog-user-project": project,
        }
        resp = session.get(url, headers=headers, params=params, timeout=timeout)
        if resp.status_code != 200:
            raise SystemExit(
                f"Failed to list Model Garden catalog via REST (HTTP {resp.status_code}):\n{resp.text[:500]}"
            )
        data = resp.json()
        entries.extend(data.get("publisherModels", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    print(f"  [catalog] {len(entries)} entries fetched.", file=sys.stderr)
    return entries


EXCLUDED_PUBLISHERS = {"internal-test-google"}


def dedupe_models(catalog):
    best = {}
    for entry in catalog:
        m = NAME_RE.search(entry.get("name", ""))
        if not m:
            continue
        publisher, model_id, version = m.group(1), m.group(2), m.group(3) or entry.get("versionId")
        if publisher in EXCLUDED_PUBLISHERS:
            continue
        key = (publisher, model_id)
        stage = entry.get("launchStage", "")
        rank = LAUNCH_STAGE_RANK.get(stage, -1)
        cur = best.get(key)
        if cur is None or (rank, version or "") > (cur["_rank"], cur["version"] or ""):
            best[key] = {
                "publisher": publisher,
                "model_id": model_id,
                "display_name": entry.get("displayName") or model_id,
                "version": version,
                "launch_stage": stage,
                "managed_api": "openGenerationAiStudio" in entry.get("supportedActions", {}),
                "_rank": rank,
            }
    out = list(best.values())
    for v in out:
        v.pop("_rank", None)
    return out


def gcloud_token_fn(timeout):
    result = run_gcloud(["auth", "print-access-token"], timeout=timeout)
    if result.returncode != 0:
        raise SystemExit(f"Failed to get access token:\n{result.stderr}")
    return result.stdout.strip()


def service_account_token_fn(sa_path):
    """Return a token function backed by a service-account key file (no gcloud).

    Swaps the SA's RSA key for an OAuth access token via the token endpoint
    declared in the key file. `google-auth` is imported lazily so the default
    gcloud path keeps working even where it isn't installed.
    """
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request as GAuthRequest
    except ImportError:
        raise SystemExit(
            "The --service-account path needs the `google-auth` package "
            "(pip install google-auth). It is not required for the default gcloud path."
        )

    with open(sa_path, encoding="utf-8") as f:
        creds = service_account.Credentials.from_service_account_info(
            json.load(f), scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )

    def fn(timeout):
        creds.refresh(GAuthRequest())
        return creds.token

    return fn


class TokenBox:
    """Caches an access token and refreshes it before it can expire."""

    def __init__(self, timeout, token_fn):
        self.timeout = timeout
        self.token_fn = token_fn
        self.token = token_fn(timeout)
        self.fetched = time.monotonic()

    def get(self):
        if time.monotonic() - self.fetched > 40 * 60:
            self.refresh()
        return self.token

    def refresh(self):
        self.token = self.token_fn(self.timeout)
        self.fetched = time.monotonic()


def check_one(session, token_box, project, region, publisher, model_id, timeout, retries):
    url = f"https://{region}-aiplatform.googleapis.com/v1/publishers/{publisher}/models/{model_id}"
    backoff = 1.0
    for attempt in range(retries + 1):
        try:
            resp = session.get(
                url,
                headers={
                    "Authorization": f"Bearer {token_box.get()}",
                    "x-goog-user-project": project,
                },
                timeout=timeout,
            )
        except requests.RequestException as e:
            if attempt == retries:
                return region, "error", str(e)
            time.sleep(backoff)
            backoff *= 2
            continue

        if resp.status_code == 200:
            return region, "available", None
        if resp.status_code == 404:
            return region, "unavailable", None
        if resp.status_code == 403:
            return region, "restricted", None
        if resp.status_code == 401:
            token_box.refresh()
            if attempt == retries:
                return region, "error", "HTTP 401"
            continue
        if resp.status_code in (429, 500, 502, 503, 504):
            if attempt == retries:
                return region, "error", f"HTTP {resp.status_code}"
            time.sleep(backoff)
            backoff *= 2
            continue
        return region, "error", f"HTTP {resp.status_code}"
    return region, "error", "retries exhausted"


def run_pass(session, token_box, project, jobs, workers, timeout, retries, label):
    """jobs: list of (publisher, model_id, region). Returns (available_set, restricted_count, errors_dict)."""
    available = set()
    restricted_count = 0
    errors = {}
    total = len(jobs)
    done = 0
    last_report = time.monotonic()

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(check_one, session, token_box, project, region, publisher, model_id, timeout, retries): (
                publisher, model_id, region,
            )
            for publisher, model_id, region in jobs
        }
        for fut in concurrent.futures.as_completed(futures):
            publisher, model_id, region = futures[fut]
            _, status, detail = fut.result()
            done += 1
            if status == "available":
                available.add((publisher, model_id, region))
            elif status == "restricted":
                restricted_count += 1
            elif status == "error":
                errors[(publisher, model_id, region)] = detail

            if time.monotonic() - last_report > 5:
                print(f"[{label}] {done}/{total} checks done", file=sys.stderr)
                last_report = time.monotonic()

    return available, restricted_count, errors


def build_provider(project, models, regions, workers, timeout, retries, token_fn):
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(pool_connections=workers, pool_maxsize=workers)
    session.mount("https://", adapter)
    token_box = TokenBox(timeout=30, token_fn=token_fn)

    jobs = [(m["publisher"], m["model_id"], region) for m in models for region in regions]
    available, restricted_count, errors = run_pass(
        session, token_box, project, jobs, workers, timeout, retries, "pass1"
    )

    # Transient TLS/network failures happen under high concurrency; retry the leftovers
    # serially-ish (much lower concurrency, more retries) before giving up on them.
    retry_round = 1
    while errors and retry_round <= 3:
        retry_jobs = list(errors.keys())
        print(f"[retry-pass {retry_round}] re-checking {len(retry_jobs)} failed checks at low concurrency", file=sys.stderr)
        retry_workers = max(3, workers // 6)
        avail2, restricted2, errors2 = run_pass(
            session, token_box, project, retry_jobs, retry_workers, timeout * 2, retries + 2, f"retry{retry_round}"
        )
        available |= avail2
        restricted_count += restricted2
        errors = errors2
        retry_round += 1

    print(
        f"[done] {len(jobs)} checks total, {len(available)} available, "
        f"{restricted_count} restricted (permission-gated), {len(errors)} unresolved errors",
        file=sys.stderr,
    )
    if errors:
        print("Unresolved after retries (treated as unknown, NOT marked available):", file=sys.stderr)
        for (pub, mid, region), detail in list(errors.items())[:20]:
            print(f"  [error] {pub}/{mid} @ {region}: {detail}", file=sys.stderr)

    results = {(m["publisher"], m["model_id"]): {} for m in models}
    for publisher, model_id, region in available:
        results[(publisher, model_id)][region] = True

    model_entries = []
    for m in models:
        avail_regions = results[(m["publisher"], m["model_id"])]
        if not avail_regions:
            continue
        mask = 1 if m["managed_api"] else 2
        model_entries.append(
            {
                "g": publisher_display(m["publisher"]),
                "n": m["display_name"],
                "v": m["version"],
                "card": None,
                "s": {region: mask for region in avail_regions},
            }
        )

    regions_present = sorted({r for m in model_entries for r in m["s"]})
    region_objs = []
    for code in regions_present:
        name, group = REGION_META.get(code, (code, "Other"))
        region_objs.append({"code": code, "name": name, "group": group})

    groups = sorted({m["g"] for m in model_entries})
    def_a = "us-central1" if "us-central1" in regions_present else (regions_present[0] if regions_present else None)
    def_b = "europe-west4" if "europe-west4" in regions_present else (
        regions_present[-1] if len(regions_present) > 1 else def_a
    )

    provider = {
        "id": "gcp",
        "name": "GCP Vertex AI",
        "logo": "G",
        "accent": "#4285f4",
        "accentInk": "#04121f",
        "subtitle": (
            "Which Model Garden models are available in which Vertex AI region, probed live via "
            "<code>GET {region}-aiplatform.googleapis.com/v1/publishers/&lt;publisher&gt;/models/&lt;model&gt;</code>. "
            "<b>Managed API</b> models (Gemini, PaLM, Claude) can be called directly; "
            "<b>Self-deploy</b> models (Llama, Mistral, Qwen, DeepSeek, etc.) must be deployed to your own endpoint "
            "and region availability reflects catalog presence, not GPU/TPU capacity."
        ),
        "source": {
            "url": "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations",
            "label": "Generative AI on Vertex AI locations (Google Cloud docs)",
        },
        "axisLabel": "Deployment type",
        "groupLabel": "Publisher",
        "unit": "model",
        "chipMode": "flat",
        "caps": [
            {
                "k": "api",
                "badge": "Managed API",
                "full": "Directly callable via the Vertex AI managed API (Model-as-a-Service)",
                "color": "#3fb950",
                "group": "Managed API",
            },
            {
                "k": "deploy",
                "badge": "Self-deploy",
                "full": "Deploy-it-yourself Model Garden model (GPU/TPU endpoint)",
                "color": "#f0a132",
                "group": "Self-deploy",
            },
        ],
        "pipGroups": [
            {"label": "Managed API", "color": "#3fb950", "keys": ["api"]},
            {"label": "Self-deploy", "color": "#f0a132", "keys": ["deploy"]},
        ],
        "defA": def_a,
        "defB": def_b,
        "groups": groups,
        "generated": datetime.date.today().isoformat(),
        "regions": region_objs,
        "models": sorted(model_entries, key=lambda m: (m["g"], m["n"], m["v"] or "")),
    }

    return provider


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", help="GCP billing/quota project ID. Required for the gcloud path; optional with --service-account (defaults to the key's project_id).")
    ap.add_argument("--service-account", help="Path to a service-account key JSON. Uses it for auth + catalog via REST instead of gcloud (no gcloud install needed).")
    ap.add_argument("--regions", help="Comma-separated region codes to query (default: built-in list of ~35)")
    ap.add_argument("--output", default="vertex.json", help="Output JSON file (default: vertex.json)")
    ap.add_argument("--workers", type=int, default=30, help="Concurrent HTTP checks (default: 30)")
    ap.add_argument("--timeout", type=int, default=20, help="Per-request timeout in seconds (default: 20)")
    ap.add_argument("--retries", type=int, default=2, help="Retries per failed check (default: 2)")
    ap.add_argument("--limit", type=int, help="Cap number of unique models checked (for testing)")
    ap.add_argument("--catalog-file", help="Reuse a previously saved `gcloud ai model-garden models list` JSON dump instead of re-fetching")
    args = ap.parse_args()

    regions = args.regions.split(",") if args.regions else list(REGION_META.keys())
    regions = [r.strip() for r in regions if r.strip()]

    if args.service_account:
        token_fn = service_account_token_fn(args.service_account)
        project = args.project
        if not project:
            with open(args.service_account, encoding="utf-8") as f:
                project = json.load(f).get("project_id")
            if not project:
                raise SystemExit("Could not determine a project: pass --project or include project_id in the SA key file.")
        print(f"[auth] using service account (project {project})", file=sys.stderr)
    else:
        token_fn = gcloud_token_fn
        if not args.project:
            raise SystemExit("--project is required when not using --service-account.")
        project = args.project

    if args.catalog_file:
        with open(args.catalog_file, encoding="utf-8") as f:
            catalog = json.load(f)
    elif args.service_account:
        catalog = fetch_catalog_rest(requests.Session(), token_fn, project, timeout=180)
    else:
        catalog = fetch_catalog(project, timeout=180)

    models = dedupe_models(catalog)
    print(f"{len(models)} unique models across {len(regions)} regions to check.", file=sys.stderr)
    if args.limit:
        models = models[: args.limit]
        print(f"Limiting to first {len(models)} models (--limit).", file=sys.stderr)

    provider = build_provider(project, models, regions, args.workers, args.timeout, args.retries, token_fn)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(provider, f, indent=2, ensure_ascii=False)

    print(
        f"\nWrote {args.output}: {len(provider['models'])} models with at least one available region, "
        f"across {len(provider['regions'])} regions.",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()

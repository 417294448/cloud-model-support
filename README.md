# cloud-model-support

A comparison page for AWS Bedrock, Azure Foundry, and GCP Vertex AI: model × region availability, lifecycle/retirement status, and deployment/inference modes.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [`index.html` Data Schema](#indexhtml-data-schema)
- [Data Pipelines](#data-pipelines)
  - [GCP Vertex AI](#gcp-vertex-ai--fully-automated)
  - [Azure Foundry](#azure-foundry)
  - [AWS Bedrock](#aws-bedrock)
- [Refreshing Data with the `refresh-model-data` Skill](#refreshing-data-with-the-refresh-model-data-skill)
- [Manual Merge Recipe](#manual-merge-recipe)
- [Page Features](#page-features)
- [Known Limitations](#known-limitations)

## Overview

`index.html` is the **only build artifact**: a single-file static page with no build step and no runtime network calls. All data is embedded as JSON directly in the file:

```html
<script id="data" type="application/json">{"providers":[{...aws}, {...azure}, {...gcp}]}</script>
```

On load, the page reads this blob via `JSON.parse(document.getElementById("data").textContent)` and renders entirely client-side from there — no fetch, no XHR.

Every other `.json` file in this repository is raw material or an intermediate artifact. None of them are read by `index.html` directly; each is scraped or generated, then merged into the embedded JSON's matching provider (`models[]`, and occasionally `caps`/`capDefGroups`). This document explains where each piece of data comes from, how it's produced, and how to merge it back — by hand or via the bundled `refresh-model-data` skill.

## Quick Start

Open `index.html` directly in a browser, or serve it locally:

```bash
python -m http.server
```

No dependencies, no build step.

## Prerequisites

Only needed if you're refreshing data, not for viewing the page:

| Tool | Used for | Check |
|---|---|---|
| `gcloud` CLI, authenticated, with access to a GCP project | Region probing for the GCP module | `gcloud auth print-access-token` |
| Python 3 + `requests` | Running `build_vertex_matrix.py` | `python -c "import requests"` |
| Node.js | All table-parsing / merge scripts | `node --version` |
| `curl` | Fetching vendor documentation pages | Preinstalled on most systems |

## Architecture

```
                    ┌───────────────────────────────────────────┐
                    │                index.html                   │
                    │   <script id="data"> embedded JSON,          │
                    │   rendered entirely client-side              │
                    └───────────────────────────────────────────┘
                                       ▲
                    merged by hand / script (see "Manual Merge Recipe")
                                       │
   ┌───────────────────────┬──────────┴──────────┬───────────────────────┐
   │           AWS          │        Azure         │          GCP           │
   │  models-region-        │  azure-model-        │  build_vertex_matrix.py│
   │  compatibility.html    │  openai/others-      │  ← gcloud + REST probe │
   │  (scraped directly,    │  ava.json            │  → vertex.json         │
   │  no intermediate file) │  (semi-structured)   │  + vertex-model-       │
   │  + aws-model-          │  + azure-model-      │  retirement.json       │
   │  retirement.json       │  retirement.json     │                        │
   │  + aws-model-runtime&  │                      │                        │
   │  mantle.json           │                      │                        │
   └───────────────────────┴──────────────────────┴───────────────────────┘
```

## Repository Layout

| File | Module | Content | How it's produced |
|---|---|---|---|
| `index.html` | — | The final page, with all data embedded | Merged output of every module below |
| `build_vertex_matrix.py` | GCP | Probes Vertex AI model × region availability | Hand-written Python script |
| `vertex_all_models.json` | GCP | Raw catalog snapshot from `gcloud ai model-garden models list`, reused via `--catalog-file` | `gcloud` output |
| `vertex.json` | GCP | Output of `build_vertex_matrix.py`; can be dropped in as the `gcp` provider object | Script-generated |
| `vertex_test.json` | GCP | Small smoke-test output from `--limit` (gitignored) | Script-generated |
| `vertex-model-retirement.json` | GCP | Release/retirement dates and replacements for Gemini/Veo/Embedding models | Scraped from official docs |
| `azure-model-openai-ava.json` | Azure | Azure OpenAI model region availability (Global Standard / Data Zone / Regional) | Scraped from official docs |
| `azure-model-others-ava.json` | Azure | Third-party/community model (Anthropic, Meta, Mistral, ...) serverless availability | Scraped from official docs |
| `azure-model-retirement.json` | Azure | Azure Foundry model retirement schedule (lifecycle/retirement_date/replacement) | Scraped from official docs |
| `aws-model-retirement.json` | AWS | Bedrock model Legacy/EOL dates, grouped by region | Scraped from official docs |
| `aws-model-runtime&mantle.json` | AWS | Whether each Bedrock model supports the classic Runtime API vs. the newer Mantle API | Scraped from official docs |
| `build.log` / `err.log` | GCP | `build_vertex_matrix.py` run logs (gitignored) | Script run artifact |
| `.claude/skills/refresh-model-data/` | All | Claude Code skill that automates the refresh pipeline | See [below](#refreshing-data-with-the-refresh-model-data-skill) |

> AWS and Azure currently have **no** raw "model × region matrix" file analogous to `vertex.json` — their model × region data is scraped and written directly into `index.html`. See the per-module sections below.

## `index.html` Data Schema

Each object in the `providers` array has these top-level fields:

| Field | Description |
|---|---|
| `id` / `name` / `logo` / `accent` / `accentInk` | Identifier, display name, logo key, theme colors |
| `subtitle` | One-line header description; supports inline `<code>`/`<b>` |
| `source` | `{url, label}` — rendered as the "Data extracted from" footer link |
| `note` | Optional second footer line (e.g. explaining what a "Deprecated" badge means and linking its source) |
| `axisLabel` / `groupLabel` / `unit` | Axis label (e.g. "Inference mode"), grouping label (e.g. "Provider"), unit noun ("model") |
| `chipMode` | `"flat"` (AWS — one row of chips) or `"grouped"` (Azure — chips grouped by category) |
| `caps` | This provider's "capability bit" definitions, each `{k, badge, full, color, group, scope?}`; `k` is the bitmask key |
| `pipGroups` | Pip-color groupings used in the matrix view, `{label, color, keys[]}` |
| `capDefGroups` | Data source for the header's definition-card strip, `[{title, items:[{label,color,full}]}]`; omit to hide the strip |
| `regions` | `[{code, name, group}]` |
| `groups` | Deduplicated list of every `g` (vendor/publisher) under this provider |
| `generated` | Snapshot date |
| `models` | See below |

Each entry in `models[]`:

| Field | Description |
|---|---|
| `g` | Group name (the underlying model publisher, e.g. "Anthropic", for AWS/GCP; same idea for Azure) |
| `n` | Model name/ID |
| `v` | Version string, or `null` if the model has no version distinction |
| `card` | Link to the model's documentation card, or `null` |
| `s` | `{region_code: bitmask}` — bit order follows this provider's `caps` array (the i-th cap is `1 << i`) |
| `lifecycle` | Optional: `"GA"` / `"Preview"` / `"Deprecated"` / `"Legacy"` / `"Retired"` / `"EOL"`. A badge only renders when this is set and isn't `"GA"` |
| `retirementDate` | Optional retirement date shown alongside `lifecycle` (can also be free text, e.g. "No retirement date announced") |
| `replacement` | Optional recommended-replacement text |
| `offer` | Optional (Azure only today), `{label, short, detail}` — marketplace availability badge |
| `api` | Optional (AWS only today), `{rt: bool, mt: bool}` — Runtime API / Mantle API support |

## Data Pipelines

### GCP Vertex AI — fully automated

```
gcloud ai model-garden models list  ──►  vertex_all_models.json (catalog snapshot, cacheable)
                                              │
                                              ▼
                        build_vertex_matrix.py (probes real per-region availability)
                                              │
                                              ▼
                                         vertex.json  ──► replaces the "gcp" provider object in index.html
```

`gcloud ai model-garden models list` has no `--region` flag — it returns the global catalog. To find out whether a given model is available in a given region, the script probes Vertex AI's regional REST endpoint for every `(publisher, model_id, region)` combination:

```
GET https://{region}-aiplatform.googleapis.com/v1/publishers/{publisher}/models/{model_id}
```

`200` = available, `404` = unavailable in that region, `403` = exists but gated behind an EULA/access grant (unrelated to region).

**Running it manually:**

```bash
# Prerequisite: gcloud CLI installed, authenticated, with access to a billing/quota project

# Option 1: full refresh — re-fetches the catalog too (slower, thousands of HTTP requests)
python build_vertex_matrix.py --project <YOUR_PROJECT_ID> --output vertex.json

# Option 2: reuse the cached catalog snapshot, only re-probe availability (faster; recommended for routine updates)
python build_vertex_matrix.py --project <YOUR_PROJECT_ID> \
  --catalog-file vertex_all_models.json --output vertex.json

# Common flags
#   --regions us-central1,europe-west4      probe only specific regions (defaults to ~35 built-in)
#   --workers 30                            concurrent probe workers (default 30)
#   --limit 20                              cap to the first N models — useful with --output vertex_test.json for a quick smoke test
```

Once it's done, splice `vertex.json` into `index.html` with `apply_update.js replace-from-provider` (see the skill section below, or the equivalent manual recipe further down).

**Vertex's lifecycle data** (`vertex-model-retirement.json`) is scraped separately, from:

- <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions#gemini-models> — release date, retirement date, and replacement model for Gemini / Gemini image / Veo / Embeddings models

This is script-assisted rather than fully automated: fetch the doc page with `curl`, regex-extract every `<table>` and parse it row by row into structured JSON (a table's heading/section title determines its category), normalize dates to `YYYY-MM-DD`, and keep the raw text in a `*_note` field whenever a date can't be parsed exactly.

### Azure Foundry

Azure splits into "primary data" (model × region availability) and "lifecycle data," and **neither is fully scripted today**:

**Primary data comes from two files:**

| File | Source |
|---|---|
| `azure-model-openai-ava.json` | <https://learn.microsoft.com/en-us/azure/foundry-classic/foundry-models/concepts/models-sold-directly-by-azure-region-availability> — Azure OpenAI models, broken down by deployment type (Global Standard / Data Zone / Regional) and then by region tab (Americas/EMEA/APAC), listing per-region availability |
| `azure-model-others-ava.json` | <https://learn.microsoft.com/en-us/azure/foundry-classic/how-to/deploy-models-serverless-availability> — third-party/community serverless models (Anthropic, Meta, Mistral, Cohere, ...), grouped by provider and deployment type, with marketplace country coverage |

Both files are semi-structured scrape output and still need to be converted into `index.html`'s Azure `models[]` shape (`{g, n, v, s, offer, lifecycle, ...}` — the `s` bitmask is encoded in the order of Azure's 8 deployment-type `caps`: `gs/dzs/std/gpm/dzpm/rpm/gb/dzb`, see `azure.caps` in `index.html`). **This conversion step currently can't be safely automated** — see [Known Limitations](#known-limitations).

**Lifecycle data** (`azure-model-retirement.json`) comes from <https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule>, structured as `sections[]` (grouped by category/provider), each containing `{model, version, lifecycle, retirement_date, replacement}`. This page's structure is simple and low-risk, so the `refresh-model-data` skill can scrape and parse it safely.

### AWS Bedrock

**Primary data** (model × In-Region/Geo/Global inference-mode availability) also has no standalone raw file — it's scraped directly from <https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html> and written straight into `index.html`'s AWS `models[]` (`s`'s bitmask: `in`=1 / `geo`=2 / `global`=4).

This page has a few structural quirks worth knowing about (the `refresh-model-data` skill's parser already handles them; keep them in mind if you're writing your own):

1. Each model is its **own `<table>`** (with a `<caption>` holding the model name and its model-card link) — it's *not* one big table per vendor.
2. Availability is rendered as `<img src=".../icon-yes.png">` / `icon-no.png`, not as text.
3. Some models (where one display name maps to multiple underlying model IDs) have **two `<table>`s sharing the same `<caption>`** — their region data must be unioned into a single record, not treated as two models or overwritten.
4. Models nearing retirement can show a literal cell value like `Legacy (EOL: YYYY-MM-DD)` instead of a yes-icon — that still counts as *available* (just scheduled to retire); only an explicit no-icon means unavailable.

**Two supplementary files:**

| File | Source | Content |
|---|---|---|
| `aws-model-retirement.json` | <https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html> | Per-model, per-region-group `legacy_date` (enters Legacy status), `eol_date` (fully retired), and `public_extended_access_start_date` |
| `aws-model-runtime&mantle.json` | <https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html> | Per-model `bedrock_runtime` (classic Runtime API) / `bedrock_mantle` (newer Mantle API) boolean support |

`index.html`'s AWS `lifecycle`/`retirementDate`/`replacement` fields come from `aws-model-retirement.json` (Legacy → `"Legacy"`, EOL → `"EOL"`; `retirementDate` is the `eol_date`). `api.rt`/`api.mt` come from `aws-model-runtime&mantle.json`.

## Refreshing Data with the `refresh-model-data` Skill

`.claude/skills/refresh-model-data/` is a Claude Code skill that codifies the fetch → parse → merge pipeline above into a reusable playbook and scripts, so refreshing data doesn't mean re-deriving the page structures and parsing logic from scratch every time.

### What it does

- Refreshes GCP, then AWS, then Azure's lifecycle data, in that order;
- Writes the result to a **new file, `index-new.html`** — it never overwrites `index.html`, so you can diff and review before promoting it;
- Overwrites the underlying raw `.json` files along the way (`vertex.json`, `vertex-model-retirement.json`, `aws-model-retirement.json`, `aws-model-runtime&mantle.json`, `azure-model-retirement.json`);
- Prints a change summary when it's done: model count deltas per provider, added/removed model names, and how many models had lifecycle fields change.

### Invoking it

Just ask, in normal language — e.g. "refresh the model data" or "check for new or retired models" — and Claude Code will pick it up. It's also fine to name it explicitly and pass a GCP project id:

> Run refresh-model-data for a full refresh, using GCP project `<your-project-id>`.

### Prerequisites and behavior

- **If GCP credentials are missing, it stops and asks you** rather than silently skipping GCP and continuing with AWS/Azure — a partial run is much easier to notice and fix than one that quietly looks complete but is missing a whole module.
- It needs a GCP billing/quota project id (see [Prerequisites](#prerequisites)); the skill will ask for one if you don't supply it.
- By default it reuses the cached model catalog in `vertex_all_models.json` and only re-probes region availability (faster); a full catalog re-fetch is only needed to pick up brand-new publishers/models.
- **Azure's primary model × region data is out of scope for automation today** — the skill skips it and explains why in its final report, refreshing only Azure's lifecycle data. See [Known Limitations](#known-limitations).

### Output and next steps

Once it's done, open `index-new.html`, spot-check a few tabs (especially anything flagged as changed), and promote it manually:

```bash
mv index-new.html index.html
```

The skill deliberately doesn't do this swap for you — it only produces a candidate file and a change report; adopting it is your call.

### Skill internals

```
.claude/skills/refresh-model-data/
├── SKILL.md                  # the playbook: what each phase does, what to do when something looks off
└── scripts/
    ├── fetch_doc.sh           # curl with a browser UA (works around WebFetch failing on some vendor doc domains)
    ├── extract_tables.js      # pulls every <table> on a page into structured rows, tagged with the nearest heading/caption
    └── apply_update.js        # the only script allowed to touch index.html's data: replace-models / replace-from-provider / patch / validate
```

`apply_update.js`'s safety design: it refuses to write to any `--out` path whose filename is literally `index.html`, regardless of `--in` — so a multi-phase run can safely read and write the same `index-new.html` over and over without ever touching the real page. Every write is followed by automatic re-validation (the data blob still parses as JSON, the page script's syntax is still valid) and a printed diff of model counts and changed fields.

## Manual Merge Recipe

If you'd rather not use the skill, here's the same logic `apply_update.js` implements internally, done by hand.

The JSON embedded in `index.html` lives on a **single line** (hundreds of thousands of characters) — regular editors and line-based tools choke on it. **Don't hand-edit that line.** Always read it out, mutate the parsed object, and write the whole thing back:

```js
// merge-example.js -- generic template for merging a supplementary JSON file into one provider's models[]
const fs = require('fs');
const path = 'index.html';
const html = fs.readFileSync(path, 'utf8');
const prefix = '<script id="data" type="application/json">';
const suffix = '</script>';
const start = html.indexOf(prefix) + prefix.length;
const end = html.indexOf(suffix, start);
const data = JSON.parse(html.slice(start, end));

const target = data.providers.find(p => p.id === 'aws'); // 'aws' | 'azure' | 'gcp'
const extra = JSON.parse(fs.readFileSync('aws-model-retirement.json', 'utf8'));

// Match on g (group/provider name) + n (model name), then write the matched
// fields back onto target.models
const lookup = new Map();
extra.models.forEach(m => lookup.set(m.provider + '|' + m.model_name, m));
target.models.forEach(mo => {
  const src = lookup.get(mo.g + '|' + mo.n);
  if (!src) return;
  // ... set mo.lifecycle / mo.retirementDate / mo.replacement / mo.api etc. as needed
});

// Write to a new file (e.g. index-new.html) rather than overwriting index.html directly
const newHtml = html.slice(0, start) + JSON.stringify(data) + html.slice(end);
fs.writeFileSync('index-new.html', newHtml, 'utf8');
```

Key points:

- **Always write the whole blob back with `JSON.stringify(data)`** — never hand-splice strings for a partial edit, it's very easy to break the JSON escaping that way.
- Prefer matching on `g` + `n` (group + model name). A few model names carry an `@version` suffix (e.g. GCP's `multimodalembedding@001`) — fall back to matching `` `${n}@${v}` `` for those.
- After merging, run the validation snippet below before eyeballing it in a browser.
- If a model from the supplementary source can no longer be found in the target list (e.g. it was already pulled from the product catalog), there's simply nowhere to attach the badge — that's expected, no special handling needed.

**Validation snippet** (run this after every merge):

```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('index-new.html','utf8');
JSON.parse(html.match(/<script id=\"data\" type=\"application\/json\">([\s\S]*?)<\/script>/)[1]); // data blob parses
new Function(html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1]);                             // page script syntax is intact
console.log('OK');
"
```

## Page Features

- Switching providers (top switcher) resets every filter. Switching between the four in-page view tabs (By Region / Compare Regions / By Model / Full Matrix) only clears the search box and group filter — other filters persist.
- Each provider's "capability bits" (`caps`) define what the columns in the model × region matrix mean (inference mode for AWS, deployment type for Azure, Managed API/Self-deploy for GCP); the header's `capDefGroups` cards give each one a one-line definition.
- `lifecycle` / `retirementDate` / `replacement` / `offer` / `api` are all optional fields — when absent, the corresponding badge simply doesn't render, and it doesn't affect whether the "Lifecycle" / "API surface" filter controls are shown (those are computed dynamically via `P.models.some(...)`).

## Known Limitations

**Azure's primary model × region data can't be safely automated yet.** In a browser, `models-sold-directly-by-azure-region-availability` looks like a clean "deployment type × geography" tabbed interface. In the underlying markup, however, it's actually **41 separate `<table>` elements** — every tab panel's HTML is fully present in the DOM at once, with JavaScript only toggling visibility — not the "3 region tabs × 6-8 deployment categories" structure one might reasonably expect from the rendered page. Without manually verifying which deployment-type/region category each of those 41 tables belongs to, a regex-based mapping is likely to produce data that's wrong but looks plausible — which is worse than not refreshing at all.

As a result:

- The `refresh-model-data` skill skips this part and only refreshes Azure's lifecycle data (`azure-model-retirement.json`), which comes from a much simpler, lower-risk page.
- Updating Azure's model × region data today requires either manually reconciling all 41 tables against their deployment-type/region categories, or investing in a proper structural analysis of the page and turning the result into a new, dedicated parser that can then be folded into the skill.
- Until that work happens, newly released Azure models that aren't already in `azure.models` won't appear on the page.

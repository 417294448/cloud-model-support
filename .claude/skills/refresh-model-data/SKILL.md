---
name: refresh-model-data
description: Refreshes AWS Bedrock / Azure Foundry / GCP Vertex AI model availability, lifecycle, and retirement data for the cloud-model-support project by re-scraping each vendor's official docs, builds a new index-new.html, then promotes it: the previous index.html is renamed to index-old.html and index-new.html is renamed to index.html. Use this whenever the user asks to refresh, update, sync, or regenerate the model data or the page for this repo, wants to check whether new models were released or old ones retired, or wants the page updated -- even if they just say "check for updates" or "refresh the data" without naming the skill. Only applies inside the cloud-model-support repo (the one with index.html and the *-model-*.json files at its root).
---

> **同步提示**：本项目同时在 `.trae/rules/refresh-model-data.md` 维护了一份面向 Trae IDE 的 rule。若本 SKILL 中的 i18n 约定、脚本路径、刷新流程或安全校验规则发生变更，请同步更新 `.trae/rules/refresh-model-data.md`，确保两者保持一致。

# Refresh cloud-model-support's model data

This produces:

- **`index-new.html`** built next to the existing `index.html`. Every step below scrapes a vendor doc page whose structure could have silently changed since last time, so all edits land in this new file first and get diffed against the original before anything is promoted.
- Once the diff report is generated (see "Final report" below), the skill **promotes it automatically**: the existing `index.html` is renamed to `index-old.html` (overwriting any previous `index-old.html`), then `index-new.html` is renamed to `index.html`. This keeps the previous version around as a one-generation backup while `index.html` always ends the run holding the freshly scraped data.
- Refreshed copies of the per-provider auxiliary files at the repo root (`vertex.json`, `vertex-model-retirement.json`, `aws-model-retirement.json`, `aws-model-runtime&mantle.json`, `azure-model-openai-ava.json`, `azure-model-others-ava.json`, `azure-model-retirement.json`). These ARE overwritten in place -- they're raw scrape outputs, not the deployed page.
- A summary report of what actually changed.

**Read `README.md` at the repo root first** if you haven't already this session. It documents the full pipeline, the exact source URL for every file, and the JSON schema `index.html`'s embedded data uses (`caps`, `s` bitmasks, `lifecycle`/`retirementDate`/`replacement`/`offer`/`api`). This file tells you *the order of operations* and hands you scripts for the risky parts; README.md is *the schema reference* -- don't duplicate its field tables from memory, go read it.

## Tooling in this skill

- `scripts/fetch_doc.sh <url> <out-file>` -- fetches a page via `curl` with a browser User-Agent. Use this instead of WebFetch for every vendor doc page: WebFetch has failed with "Unable to verify if domain is safe" on `docs.aws.amazon.com` and `docs.cloud.google.com` in past runs. curl has no such gate.
- `scripts/extract_tables.js <html-file> [--index N]` -- pulls every `<table>` out of a fetched page into plain-text rows, tagged with the nearest heading. Run without `--index` first to see how many tables there are and what their headers look like; run with `--index N` to dump one table's full rows once you know which one you need.
- `scripts/apply_update.js` -- the only thing allowed to touch `index.html`'s embedded data. See "Applying changes" below.
- `scripts/build_azure_models.js` -- converts `azure-model-openai-ava.json` + `azure-model-others-ava.json` (+ optionally `azure-model-retirement.json`) into the `azure.models[]`/`azure.groups` shape `apply_update.js replace-models` expects. See Phase 3 below -- read its header comment before using it, there are several non-obvious dedup/inference rules baked in.

**`/tmp` paths and Windows.** The examples below write scratch files to `/tmp/...`. That's fine on macOS/Linux, and on Windows *as long as the file only moves between bash and node* (they agree on `/tmp`). But **never hand a `/tmp` path to `python` on Windows** -- native-Windows python resolves `/tmp` to a different directory than bash/node do, so a file bash/node wrote to `/tmp/x.json` is `FileNotFoundError` when python reads `--catalog-file /tmp/x.json`. Use a relative, repo-local path (e.g. `mini-catalog.json`) for anything python reads. Also: the ~5 MB `vertex_all_models.json` contains non-ASCII that python's default Windows codec (gbk) rejects -- parse it with `node`, or `open(..., encoding="utf-8")` if you must use python.

**The page's i18n / top-nav code is NOT scraped data -- `apply_update.js` preserves it, don't hand-edit the data line.** `index.html` carries hand-written features that live *outside* the `<script id="data">` blob: the English/中文 language toggle (`#langToggle`, the `I18N` dictionary, `t()`/`applyLang()`, all `data-i18n`/`data-i18n-ph`/`data-i18n-aria` attributes on static nodes) and the top-right nav buttons (首页/Home link to `https://www.cloudproduct.top/`, language toggle, theme toggle). Every `apply_update.js` subcommand (`replace-models` / `replace-from-provider` / `patch`) only splices the single data line via `html.slice(0, dataStart) + JSON.stringify(data) + html.slice(dataEnd)` -- it never rewrites the markup or logic around it, so all of this survives a refresh untouched (verified: `lang-toggle`/`home-link`/`I18N`/`首页`/`t("headTitle")` counts are identical before and after `patch` and `replace-from-provider`, and `validate` passes). Three corollaries:

- **Never fix or translate a UI string by editing the embedded JSON's `subtitle`/`caps[].full`/`note`/`offer.detail` fields.** Those are presentation strings that refresh deliberately leaves alone (they're "hand-tuned presentation data" per `apply_update.js`'s own contract), but they are *data*, re-derived by `build_vertex_matrix.py` and the scrape phases, so editing them in the blob is both the wrong layer and not durable. **Data text stays English in the JSON blob.** Translations for provider-specific data-driven copy live in the inline JS's `PROVIDER_ZH` map:
  - `subtitle` → `providerSubtitle()`
  - `note` → `providerNote()`
  - `caps[].full` tooltip text → `capFullZh(capKey)`
  - `capDefGroups` item descriptions → `capDefFullZh(label, full, title)`
  - `capDefGroups` titles (Azure) → `capDefTitleZh(title)`
  
  Generic UI text still belongs in the `I18N` dictionary / `data-i18n` attributes. Both dictionaries are preserved by every `apply_update.js` subcommand because they live outside the `<script id="data">` blob.
- **If you add/change a translated UI string or provider copy, edit the appropriate map/dictionary in the inline JS, then run `apply_update.js validate index.html`** (or just `node --check` on the extracted logic script) to confirm the inline JS still parses -- the `validate` subcommand `new Function()`-checks the whole `<script>` and will catch a broken `t()` call, an unterminated template literal, or a syntax error in `PROVIDER_ZH`.
- **When adding a new provider, add a matching `PROVIDER_ZH[id]` entry.** At minimum include `subtitle`, `note`, and `capFull`. If the provider uses `capDefGroups`, also include `capDefFull` and (when titles exist) `capDefTitle`. Until the entry is added, the page gracefully falls back to the English data text.
- **`build_vertex_matrix.py` only regenerates the GCP provider object (data), not the page.** It writes `vertex.json` (consumed via `replace-from-provider`), so it has no interaction with the i18n/nav code at all -- no need to touch it when changing UI text, and changing UI text never requires re-running it. `replace-from-provider` intentionally copies only `models`/`regions`/`groups`/`generated` from `vertex.json`; `subtitle`/`caps`/`note`/`capDefGroups` stay as they are in `index.html`.

## Determine this run's scope, before doing anything else

This skill can refresh all three providers, or just one. Read the user's request and decide `scope` = `{gcp, aws, azure}` (full run) or a subset before touching any of the phases below:

- They named a provider ("check if Azure has new models", "refresh AWS's retirement dates", "只刷新一下GCP的数据") -> scope is that provider only.
- They asked generically ("refresh the data", "check for updates", no provider mentioned) -> scope is all three, the default full run.
- If it's ambiguous which they mean, ask rather than guess -- a wrong guess here means either doing unwanted work (including possibly hitting the GCP credential gate below for a request that had nothing to do with GCP) or silently skipping something they wanted.

Run *only* the phase(s) for providers in scope. Skip the GCP preflight check entirely when GCP isn't in scope -- it exists to unblock Phase 1, not as a mandatory gate for every invocation of this skill. A request to refresh Azure alone should never stop to ask about `gcloud` credentials.

## If GCP is in scope: preflight the GCP credential

The GCP phase needs an authenticated `gcloud` and a project ID. Before anything else, have the user run these two prerequisites -- the first opens a browser for interactive login, so you can't run it for them (suggest they type `! gcloud auth login` in the prompt so its output lands here):

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
```

Then verify the credential is actually live:

```bash
gcloud auth print-access-token >/dev/null 2>&1 && echo AUTHED || echo NOT_AUTHED
```

If `NOT_AUTHED`, or `gcloud` isn't on PATH at all: **stop and ask the user -- don't decide for them.** Tell them plainly what's missing (`gcloud` not installed, or not logged in -- `gcloud auth login`, and possibly `gcloud config set project <id>`), then use AskUserQuestion with options along the lines of "I've fixed it, retry the check" / "Skip the GCP refresh this run, continue with AWS/Azure only" / "Stop entirely." The user has explicitly asked that this pause and wait for their call rather than silently skipping GCP and plowing ahead -- respect that even if skipping would be more convenient.

Take the GCP project ID from whatever the user passed when invoking this skill. If they didn't give one and you're proceeding with the GCP phase, ask for it.

## Chaining multiple updates into one index-new.html

This only matters when more than one provider is in scope. A full run touches the same file three times (GCP, then AWS, then Azure). The **first** `apply_update.js` call in the run reads `index.html` and writes `index-new.html`. **Every call after that** -- including later steps within the same provider's phase, and every subsequent provider's phase -- reads `index-new.html` and writes `index-new.html` again (in place), since it already exists as the working copy at that point. Don't re-read `index.html` partway through or you'll throw away earlier changes.

If only one provider is in scope, there's no chaining to think about: that provider's first `apply_update.js` call reads `index.html` and writes `index-new.html`, and every later call in that same phase reads/writes `index-new.html` (a "run" of one phase still has multiple `apply_update.js` calls -- e.g. AWS's model matrix, lifecycle, and runtime/mantle steps -- so the same "first call reads index.html, rest read index-new.html" rule still applies *within* that one phase).

## Phase 1 -- GCP Vertex AI

*(Skip this whole phase if `gcp` isn't in this run's scope.)*

1. Rebuild the model x region matrix. Reuse the cached catalog dump by default -- it's much faster and the catalog (which publishers/models exist at all) changes far less often than region availability:

   ```bash
   python build_vertex_matrix.py --project <PROJECT_ID> --catalog-file vertex_all_models.json --output vertex.json
   ```

   This overwrites `vertex.json` in place -- expected, it's a build artifact.

   **The cached catalog can be stale and silently drop brand-new models.** `vertex_all_models.json` is a snapshot from whenever it was last refreshed; models released since won't be in it, won't be probed, and won't appear in `vertex.json` -- and you can't tell from the matrix build alone. One signal (checked after step 3, once you have the retirement doc): cross-check the doc's *active* model IDs (everywhere except the "Retired models" section) against `vertex.json`'s `models[]`; if the doc lists a model `vertex.json` lacks, the cache predates that model's release. Once you suspect staleness, don't reach for a full re-fetch -- use the targeted probe below. It also catches new models the retirement doc *doesn't* cover (e.g. Anthropic, NVIDIA), because it diffs the catalog itself rather than relying on the doc.

   **A full re-probe stalls on GCP quota -- probe only the new entries and merge instead.** Running `build_vertex_matrix.py` with no `--catalog-file` (the "full refresh" path) shortly after a prior build frequently stalls at ~20%: GCP rate-limits the burst of ~10000 regional probes and all 30 workers back off at once; the process stays alive (~185 MB) but progress stops for minutes, and killing + re-running hits the same wall. Instead, refresh just the catalog, diff it against the prior cache to find newly-added entries, probe *only those*, and merge into the matrix you already built today (whose region data is fresh -- no need to re-probe existing models):

   ```bash
   # 1. refresh the catalog cache (overwrites vertex_all_models.json in place):
   gcloud ai model-garden models list --billing-project <PROJECT_ID> --format=json --limit=unlimited > vertex_all_models.json
   # 2. diff old vs new catalog to get the ADDED entry objects. Parse with node, NOT python --
   #    the ~5MB JSON has non-ASCII that python's default Windows codec (gbk) rejects; node reads utf-8 fine:
   #      added = newCatalog.filter(e => !oldNames.has(e.name))   // oldNames = Set of old entry .name
   # 3. write those added entries to a mini-catalog. Use a RELATIVE path, never /tmp on Windows
   #    (see "/tmp paths and Windows" in Tooling below):
   #      fs.writeFileSync("mini-catalog.json", JSON.stringify(added))
   # 4. probe only the new models:
   python build_vertex_matrix.py --project <PROJECT_ID> --catalog-file mini-catalog.json --output vertex-newonly.json --workers 8
   # 5. merge vertex-newonly.json into vertex.json (dedupe by g+n+v, union groups, assert caps match):
   node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync("vertex.json"));const n=JSON.parse(fs.readFileSync("vertex-newonly.json"));if(JSON.stringify(v.caps)!==JSON.stringify(n.caps))throw Error("caps differ -- do not merge");const ex=new Set(v.models.map(m=>m.g+"|"+m.n+"|"+m.v));for(const m of n.models){const k=m.g+"|"+m.n+"|"+m.v;if(!ex.has(k)){v.models.push(m);ex.add(k);}}for(const g of n.groups){if(!v.groups.includes(g))v.groups.push(g);}fs.writeFileSync("vertex.json",JSON.stringify(v,null,2));'
   ```

   This yields the same matrix a full re-fetch would, minus re-probing the models you already probed today -- faster, and it doesn't stall. `mini-catalog.json` and `vertex-newonly.json` are scratch (not tracked); delete them after the merge.

2. Splice it into the page:

   ```bash
   node .claude/skills/refresh-model-data/scripts/apply_update.js replace-from-provider \
     index.html gcp vertex.json --out index-new.html --generated $(date +%Y-%m-%d)
   ```

   Read the printed added/removed list. If a large chunk of models suddenly vanished, that's more likely a `gcloud` auth/quota hiccup than a real product change -- sanity-check by probing a couple of the vanished models directly before trusting it. The script sends an `x-goog-user-project: <PROJECT_ID>` header on every probe; your manual curl must too, or *every* region returns `403` and looks like EULA-gating when it's really just a missing billing-project header:

   ```bash
   TOKEN=$(gcloud auth print-access-token)
   curl -s -o /dev/null -w "%{http_code}\n" \
     -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: <PROJECT_ID>" \
     "https://<region>-aiplatform.googleapis.com/v1/publishers/<publisher>/models/<model_id>"
   # 200 = available in that region | 404 = not deployed there | 403 = exists but EULA-gated
   # (region-independent; the script counts these as "restricted", NOT available)
   ```

3. Refresh the Gemini/Veo/Embeddings retirement data:

   ```bash
   bash .claude/skills/refresh-model-data/scripts/fetch_doc.sh \
     "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions" /tmp/gcp-versions.html
   node .claude/skills/refresh-model-data/scripts/extract_tables.js /tmp/gcp-versions.html
   ```

   This prints each table's heading and header row -- compare against `vertex-model-retirement.json`'s existing `sections[]` to see if anything's shaped differently now. Dump the tables you need (`--index N`) and rebuild `vertex-model-retirement.json` in its current shape (`release_date`/`retirement_date` as ISO dates when exact, `*_note` holding the raw text otherwise, `replacement`).

4. Turn the new retirement data into a `patch.json` (see "Writing a patch.json" below) and apply it:

   ```bash
   node .claude/skills/refresh-model-data/scripts/apply_update.js patch \
     index-new.html gcp /tmp/gcp-retirement-patch.json --out index-new.html
   ```

   `vertex-model-retirement.json` carries `release_date`/`retirement_date`/`retirement_date_note`/`replacement` but **no `lifecycle` field** -- you derive it for the patch. The existing `index.html` data follows one consistent rule (an observed convention, not an authoritative source): an exact `retirement_date` (a real ISO date, not a `*_note`) **and** a non-empty `replacement` -> `"Deprecated"`; everything else -> `"Legacy"`. Set `retirementDate` to `retirement_date` when it's an exact date, otherwise to `retirement_date_note` (e.g. `"May 19, 2027 or later"`, `"No retirement date announced"`, `"No sooner than May 20, 2028"`). Edge case: a model whose retirement date has already passed but is still in the catalog (e.g. the Veo 3.0/2.0 series, retired 2026-06-30) still takes `"Deprecated"` under this rule -- leave it; don't invent `"Retired"`/`"EOL"`, the existing data never uses them.

   Match with `matchKeys: ["n"]`. A few doc IDs carry an `@version` suffix (e.g. `multimodalembedding@001`); `build_vertex_matrix.py` stores those **split** -- `n="multimodalembedding"`, `v="001"` -- so `apply_update.js`'s `match.n` must be the **bare name with the `@version` stripped** (`"multimodalembedding"`), not the suffixed form, or it won't match. (Leave "Retired models"-section entries out of the patch entirely -- those models are already out of the catalog, so there's nothing to patch onto; `apply_update.js` would just report them unmatched.)

## Phase 2 -- AWS Bedrock

*(Skip this whole phase if `aws` isn't in this run's scope.)*

1. Main model x inference-mode matrix (no intermediate file -- scraped straight into the page):

   ```bash
   bash .claude/skills/refresh-model-data/scripts/fetch_doc.sh \
     "https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html" /tmp/aws-region.html
   node .claude/skills/refresh-model-data/scripts/extract_tables.js /tmp/aws-region.html
   ```

   Each publisher (AI21 Labs, Amazon, Anthropic, ...) is its own table. Build a `models.json` array in the `{g, n, v, card, s}` shape (README.md has the field reference; `s`'s bitmask is keyed by AWS's three `caps` -- `in`=1, `geo`=2, `global`=4), then:

   ```bash
   node .claude/skills/refresh-model-data/scripts/apply_update.js replace-models \
     index-new.html aws /tmp/aws-models.json --out index-new.html --generated $(date +%Y-%m-%d)
   ```

   (First call of the run instead reads `index.html` -- see "Chaining" above.)

2. Lifecycle data:

   ```bash
   bash .claude/skills/refresh-model-data/scripts/fetch_doc.sh \
     "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html" /tmp/aws-lifecycle.html
   node .claude/skills/refresh-model-data/scripts/extract_tables.js /tmp/aws-lifecycle.html
   ```

   Rebuild `aws-model-retirement.json` in its existing shape, write a `patch.json` (`lifecycle: "Legacy"`/`"EOL"`, `retirementDate`, matched on `g`+`n`), apply it.

3. Runtime/Mantle API support:

   ```bash
   bash .claude/skills/refresh-model-data/scripts/fetch_doc.sh \
     "https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html" /tmp/aws-endpoints.html
   node .claude/skills/refresh-model-data/scripts/extract_tables.js /tmp/aws-endpoints.html
   ```

   Rebuild `aws-model-runtime&mantle.json`, patch each matched model's `api: {rt, mt}`.

## Phase 3 -- Azure Foundry

*(Skip this whole phase if `azure` isn't in this run's scope.)*

Same shape as AWS, three fetches -- each row below is one supplementary file and the exact page it's scraped from (also mirrored in README.md's "Azure Foundry" pipeline section under Data Pipelines, not the Repository Layout table, which only says "scraped from official docs" and doesn't repeat the URLs):

| File | Source URL | Feeds |
|---|---|---|
| `azure-model-openai-ava.json` | <https://learn.microsoft.com/en-us/azure/foundry-classic/foundry-models/concepts/models-sold-directly-by-azure-region-availability> | most of `azure` provider's `models[]` -- see note below, it's not just OpenAI |
| `azure-model-others-ava.json` | <https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners> | rest of `azure` provider's `models[]` (third-party/community models) |
| `azure-model-retirement.json` | <https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule> | patch `lifecycle`/`retirementDate`/`replacement` |

`azure-model-retirement.json` already carries this as a top-level `"source"` field you can read directly from the file. `azure-model-openai-ava.json` and `azure-model-others-ava.json` don't (a pre-existing inconsistency) -- their source is only documented here and in README.md, so don't rely on the files being self-describing the way the other supplementary JSON files (`aws-model-retirement.json`, `aws-model-runtime&mantle.json`, `vertex-model-retirement.json`) are.

**`azure-model-others-ava.json`'s source URL changes over time -- verify it before trusting it.** The "classic" doc tree (`foundry-classic/...`) and the current one (`foundry/...`) are parallel, independently-edited branches for two different Foundry portal experiences; Microsoft periodically retires a classic URL and 301-redirects it into the current tree. Before re-fetching, `curl -sIL` the URL above and confirm it still resolves to itself (no redirect) and its `<meta name="ms.date">` looks recent -- if it 301s somewhere else, or the classic and current versions of the page have diverged (compare their `ms.date` and table row counts), update this table and README.md's copy of it, don't just silently follow the redirect.

**`azure-model-openai-ava.json` is not limited to OpenAI models.** Its `standard`/`provisioned`/`batch` trees each have an `openai` category *and* an `other_sold_by_azure` (sometimes also `other_model_collections`) category. Those "other" categories are models Azure sells **directly** (not via third-party marketplace billing) from other publishers -- observed so far: DeepSeek, Cohere (rerank v4 / command-a), Black Forest Labs (FLUX), Moonshot AI (Kimi), xAI (grok), Meta (Llama-3.3 / Llama-4-Maverick), Microsoft (MAI-Image, Phi-4 family), Mistral (Mistral-Large-3, mistral-medium-3-5). This is a large chunk of `azure.models` and easy to miss if you only look at the file's name.

**Converting both files into `azure.models[]` shape is now scripted** -- `scripts/build_azure_models.js` handles the bitmask construction (`gs/dzs/std/gpm/dzpm/rpm/gb/dzb`, 8 positions, see `index.html`'s `azure.caps` or README.md), publisher (`g`) inference for the "other_sold_by_azure" models (by name prefix -- read the script's header comment before adding a new provider, since an unrecognized prefix gets tagged `UNKNOWN:<name>` and printed to stderr instead of silently misfiled), `offer` badge construction, and de-duplication when a model appears in both files (prefer `azure-model-openai-ava.json`'s data -- it has real region support, `azure-model-others-ava.json`'s entry for the same model is often just a capability-table placeholder with no matrix data, e.g. the Phi-4 family):

```bash
node .claude/skills/refresh-model-data/scripts/build_azure_models.js \
  --openai azure-model-openai-ava.json \
  --others azure-model-others-ava.json \
  --retirement azure-model-retirement.json \
  --out-models azure-models-built.json \
  --out-groups azure-groups-built.json

node .claude/skills/refresh-model-data/scripts/apply_update.js replace-models \
  index-new.html azure azure-models-built.json --out index-new.html \
  --groups azure-groups-built.json --generated $(date +%Y-%m-%d)
```

Read the script's stderr output: it reports OA/others counts, which (g,n) pairs were skipped as duplicates, and any `UNKNOWN:` group it couldn't infer. A provider present in `index.html` today but absent from both source files (observed: Nixtla, Stability AI) will legitimately disappear from the output -- `replace-models`/`diff` will report it as "removed," which is expected until a 3rd source covers it, not a bug in the script.

What's still NOT automated: turning the raw HTML of `models-sold-directly-by-azure-region-availability` into the structured `azure-model-openai-ava.json` shape in the first place. See [Known Limitations](#known-limitations) -- that page's tabbed UI hides 41 separate `<table>` elements in the DOM, and mis-mapping which deployment-type/region category each belongs to produces wrong-but-plausible data. `build_azure_models.js` trusts that `azure-model-openai-ava.json`/`azure-model-others-ava.json` are already correctly structured; it doesn't re-derive that structure from HTML.

## Writing a patch.json

All the "lifecycle/retirement" merges (AWS x2, Azure, GCP) share one shape:

```json
{
  "matchKeys": ["g", "n"],
  "updates": [
    { "match": {"g": "Anthropic", "n": "Claude Sonnet 5"}, "set": {"lifecycle": "Deprecated", "retirementDate": "2026-10-16", "replacement": "Claude Sonnet 6"} }
  ]
}
```

`match` locates the model by whatever fields `matchKeys` names (default `g`+`n`); `set` is merged onto that model object as-is -- whatever keys you put there get overwritten, nothing else on the model is touched. If a model in the doc no longer exists in the page's model list (already fully retired and removed from the catalog), there's nothing to patch it onto -- `apply_update.js` will report it as unmatched rather than erroring, which is the expected, harmless case.

## Final report

Once every phase has written its last `index-new.html`, run one authoritative structural diff against the original -- don't rely on recalling each `apply_update.js` call's own printed output from earlier in the run, that only shows added/removed models and aggregate field-change *counts*. It never shows a model that kept its `(g,n,v)` key but had its region support, lifecycle, or dates actually change, which is the most common kind of real update:

```bash
node .claude/skills/refresh-model-data/scripts/apply_update.js diff index.html index-new.html \
  --out "diffs/refresh-diff-$(date +%Y-%m-%d).txt"
```

This re-parses both files fresh and prints, per provider: regions/groups added or removed, model count before -> after, added/removed model names, and a field-by-field diff for every model present on both sides (region-bitmask changes decoded into cap badges, not raw numbers). A plain text/line diff (`diff`, `git diff`) is useless here -- the whole data blob is one line -- so this command is the only way to see a real diff. `--out` is optional but recommended -- it writes the same report to a dated text file under `diffs/` (tracked, since these reports are part of the refresh history) so the human reviewer has something to open and read alongside `index-new.html` instead of only your paraphrase of it.

Running `diff` needs no adjustment for a scoped (single-provider) run -- providers outside scope were never touched, so they'll simply show no changes. `apply_update.js diff` still works the same way.

Build the final report from this output:

- State the scope up front: which provider(s) this run actually touched, so a scoped run is never mistaken for a full one (e.g. "This was an Azure-only refresh, per your request -- AWS and GCP were not touched.").
- Per provider in scope: the regions/groups/model-count deltas and the changed-model list this command printed.
- Anything left out and *why*, distinguishing the two different reasons: out of scope (the user didn't ask for it this run) vs. skipped due to a blocker (e.g. GCP creds unavailable at the preflight step, mid-run).
- Flag anything that looks like a regression rather than a genuine upstream update -- e.g. a `lifecycle`/`retirementDate` that went from a real value to `null`, or a model that lost most of its regions -- and call it out explicitly rather than reporting it as routine.

## Promoting index-new.html

After the diff report above is written, promote the result -- this is a standard, automatic step of every run, not something to ask permission for:

```bash
mv index.html index-old.html
mv index-new.html index.html
```

Do this for every run regardless of scope (full or single-provider) as long as at least one phase actually ran and produced an `index-new.html`. `index-old.html` is overwritten each run -- it only ever holds the immediately-prior version, not a history. Mention the swap in the final report (e.g. "Promoted index-new.html to index.html; the previous version is saved as index-old.html.") so the human still knows to spot-check `index.html` and can recover the prior version from `index-old.html` if the diff turns out to hide a problem.

If a run is aborted mid-way (e.g. a doc page didn't match what's documented, see below) and no usable `index-new.html` was produced, skip the promotion entirely -- don't rename a partial or non-existent file.

## When a doc page doesn't match what's documented here

Vendor docs restructure without notice. If `extract_tables.js`'s output for a page looks different from what README.md or this file describes -- different column count, a missing heading, an extra table that wasn't there before -- stop and tell the user what changed rather than guessing at a mapping and silently producing wrong data. A wrong `index-new.html` that looks plausible is worse than an incomplete run that flags the problem.

---
name: refresh-model-data
description: Refreshes AWS Bedrock / Azure Foundry / GCP Vertex AI model availability, lifecycle, and retirement data for the cloud-model-support project by re-scraping each vendor's official docs, then regenerates a new index-new.html -- never overwriting the existing index.html so a human can review the diff first. Use this whenever the user asks to refresh, update, sync, or regenerate the model data or the page for this repo, wants to check whether new models were released or old ones retired, or wants an up-to-date index-new.html -- even if they just say "check for updates" or "refresh the data" without naming the skill. Only applies inside the cloud-model-support repo (the one with index.html and the *-model-*.json files at its root).
---

# Refresh cloud-model-support's model data

This produces:

- **`index-new.html`** next to the existing `index.html`. This skill never writes to `index.html` itself. Every step below scrapes a vendor doc page whose structure could have silently changed since last time, so the safety net is: always land in a new file, always print what changed, let a human decide whether to promote it.
- Refreshed copies of the per-provider auxiliary files at the repo root (`vertex.json`, `vertex-model-retirement.json`, `aws-model-retirement.json`, `aws-model-runtime&mantle.json`, `azure-model-openai-ava.json`, `azure-model-others-ava.json`, `azure-model-retirement.json`). These ARE overwritten in place -- they're raw scrape outputs, not the deployed page.
- A summary report of what actually changed.

**Read `README.md` at the repo root first** if you haven't already this session. It documents the full pipeline, the exact source URL for every file, and the JSON schema `index.html`'s embedded data uses (`caps`, `s` bitmasks, `lifecycle`/`retirementDate`/`replacement`/`offer`/`api`). This file tells you *the order of operations* and hands you scripts for the risky parts; README.md is *the schema reference* -- don't duplicate its field tables from memory, go read it.

## Tooling in this skill

- `scripts/fetch_doc.sh <url> <out-file>` -- fetches a page via `curl` with a browser User-Agent. Use this instead of WebFetch for every vendor doc page: WebFetch has failed with "Unable to verify if domain is safe" on `docs.aws.amazon.com` and `docs.cloud.google.com` in past runs. curl has no such gate.
- `scripts/extract_tables.js <html-file> [--index N]` -- pulls every `<table>` out of a fetched page into plain-text rows, tagged with the nearest heading. Run without `--index` first to see how many tables there are and what their headers look like; run with `--index N` to dump one table's full rows once you know which one you need.
- `scripts/apply_update.js` -- the only thing allowed to touch `index.html`'s embedded data. See "Applying changes" below.
- `scripts/build_azure_models.js` -- converts `azure-model-openai-ava.json` + `azure-model-others-ava.json` (+ optionally `azure-model-retirement.json`) into the `azure.models[]`/`azure.groups` shape `apply_update.js replace-models` expects. See Phase 3 below -- read its header comment before using it, there are several non-obvious dedup/inference rules baked in.

## Determine this run's scope, before doing anything else

This skill can refresh all three providers, or just one. Read the user's request and decide `scope` = `{gcp, aws, azure}` (full run) or a subset before touching any of the phases below:

- They named a provider ("check if Azure has new models", "refresh AWS's retirement dates", "只刷新一下GCP的数据") -> scope is that provider only.
- They asked generically ("refresh the data", "check for updates", no provider mentioned) -> scope is all three, the default full run.
- If it's ambiguous which they mean, ask rather than guess -- a wrong guess here means either doing unwanted work (including possibly hitting the GCP credential gate below for a request that had nothing to do with GCP) or silently skipping something they wanted.

Run *only* the phase(s) for providers in scope. Skip the GCP preflight check entirely when GCP isn't in scope -- it exists to unblock Phase 1, not as a mandatory gate for every invocation of this skill. A request to refresh Azure alone should never stop to ask about `gcloud` credentials.

## If GCP is in scope: preflight the GCP credential

The GCP phase needs an authenticated `gcloud` and a project ID. Check this *first*, before spending time on AWS/Azure, so you're not stuck mid-run deciding what to do about it:

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

1. Rebuild the model x region matrix. Reuse the cached catalog dump by default -- it's much faster and the catalog (which publishers/models exist at all) changes far less often than region availability. Only pass a full re-fetch if the user specifically wants brand-new publishers/models that might be missing from the cache:

   ```bash
   python build_vertex_matrix.py --project <PROJECT_ID> --catalog-file vertex_all_models.json --output vertex.json
   # full refresh instead (slower -- re-lists the whole Model Garden catalog too):
   #   python build_vertex_matrix.py --project <PROJECT_ID> --output vertex.json
   ```

   This overwrites `vertex.json` in place -- expected, it's a build artifact.

2. Splice it into the page:

   ```bash
   node .claude/skills/refresh-model-data/scripts/apply_update.js replace-from-provider \
     index.html gcp vertex.json --out index-new.html --generated $(date +%Y-%m-%d)
   ```

   Read the printed added/removed list. If a large chunk of models suddenly vanished, that's more likely a `gcloud` auth/quota hiccup than a real product change -- sanity-check before trusting it.

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

   Match on `n`, falling back to `` `${n}@${v}` `` for versioned IDs like `multimodalembedding@001` that the doc writes with an `@version` suffix.

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
  --out "refresh-diff-$(date +%Y-%m-%d).txt"
```

This re-parses both files fresh and prints, per provider: regions/groups added or removed, model count before -> after, added/removed model names, and a field-by-field diff for every model present on both sides (region-bitmask changes decoded into cap badges, not raw numbers). A plain text/line diff (`diff`, `git diff`) is useless here -- the whole data blob is one line -- so this command is the only way to see a real diff. `--out` is optional but recommended -- it writes the same report to a dated text file (gitignored scratch output, not something to commit) so the human reviewer has something to open and read alongside `index-new.html` instead of only your paraphrase of it.

Running `diff` needs no adjustment for a scoped (single-provider) run -- providers outside scope were never touched, so they'll simply show no changes. `apply_update.js diff` still works the same way.

Build the final report from this output:

- State the scope up front: which provider(s) this run actually touched, so a scoped run is never mistaken for a full one (e.g. "This was an Azure-only refresh, per your request -- AWS and GCP were not touched.").
- Per provider in scope: the regions/groups/model-count deltas and the changed-model list this command printed.
- Anything left out and *why*, distinguishing the two different reasons: out of scope (the user didn't ask for it this run) vs. skipped due to a blocker (e.g. GCP creds unavailable at the preflight step, mid-run).
- Flag anything that looks like a regression rather than a genuine upstream update -- e.g. a `lifecycle`/`retirementDate` that went from a real value to `null`, or a model that lost most of its regions -- and call it out explicitly rather than reporting it as routine.
- A reminder that `index-new.html` is a candidate, not a done deal: suggest they open it and spot-check a couple of tabs, and only replace `index.html` with it once they're satisfied (e.g. `mv index-new.html index.html`) -- don't do that swap yourself unless they explicitly ask you to.

## When a doc page doesn't match what's documented here

Vendor docs restructure without notice. If `extract_tables.js`'s output for a page looks different from what README.md or this file describes -- different column count, a missing heading, an extra table that wasn't there before -- stop and tell the user what changed rather than guessing at a mapping and silently producing wrong data. A wrong `index-new.html` that looks plausible is worse than an incomplete run that flags the problem.

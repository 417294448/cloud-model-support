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

## Before anything else: preflight the GCP credential

The GCP phase needs an authenticated `gcloud` and a project ID. Check this *first*, before spending time on AWS/Azure, so you're not stuck mid-run deciding what to do about it:

```bash
gcloud auth print-access-token >/dev/null 2>&1 && echo AUTHED || echo NOT_AUTHED
```

If `NOT_AUTHED`, or `gcloud` isn't on PATH at all: **stop and ask the user -- don't decide for them.** Tell them plainly what's missing (`gcloud` not installed, or not logged in -- `gcloud auth login`, and possibly `gcloud config set project <id>`), then use AskUserQuestion with options along the lines of "I've fixed it, retry the check" / "Skip the GCP refresh this run, continue with AWS/Azure only" / "Stop entirely." The user has explicitly asked that this pause and wait for their call rather than silently skipping GCP and plowing ahead -- respect that even if skipping would be more convenient.

Take the GCP project ID from whatever the user passed when invoking this skill. If they didn't give one and you're proceeding with the GCP phase, ask for it.

## Chaining multiple updates into one index-new.html

A full run touches the same file three times (GCP, then AWS, then Azure). The **first** `apply_update.js` call in a run reads `index.html` and writes `index-new.html`. **Every call after that** reads `index-new.html` and writes `index-new.html` again (in place) -- it already exists as the working copy at that point. Don't re-read `index.html` for later phases or you'll throw away earlier phases' changes.

## Phase 1 -- GCP Vertex AI

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

Same shape as AWS, three fetches (full source URLs are in README.md's file inventory table):

| Source page | Feeds |
|---|---|
| `models-sold-directly-by-azure-region-availability` | `azure-model-openai-ava.json` -> part of `azure` provider's `models[]` |
| `deploy-models-serverless-availability` | `azure-model-others-ava.json` -> rest of `azure` provider's `models[]` (third-party/community models) |
| `model-retirement-schedule` | `azure-model-retirement.json` -> patch `lifecycle`/`retirementDate`/`replacement` |

Azure's `s` bitmask has 8 positions (`gs/dzs/std/gpm/dzpm/rpm/gb/dzb` -- see `index.html`'s `azure.caps`, or README.md). Merge the OpenAI-model table data and the others-model data into one array before calling `replace-models` on the `azure` provider, same pattern as AWS phase 2 step 1.

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

Compile what each `apply_update.js` call already printed into one message back to the user -- you don't need to re-derive any of this, it's in your terminal output from each step:

- Per provider: model count before -> after, added model names, removed model names.
- Per patch: how many models changed and which fields.
- Anything skipped (e.g. GCP, if the user chose to skip it at the preflight step) and why.
- A reminder that `index-new.html` is a candidate, not a done deal: suggest they open it and spot-check a couple of tabs, and only replace `index.html` with it once they're satisfied (e.g. `mv index-new.html index.html`) -- don't do that swap yourself unless they explicitly ask you to.

## When a doc page doesn't match what's documented here

Vendor docs restructure without notice. If `extract_tables.js`'s output for a page looks different from what README.md or this file describes -- different column count, a missing heading, an extra table that wasn't there before -- stop and tell the user what changed rather than guessing at a mapping and silently producing wrong data. A wrong `index-new.html` that looks plausible is worse than an incomplete run that flags the problem.

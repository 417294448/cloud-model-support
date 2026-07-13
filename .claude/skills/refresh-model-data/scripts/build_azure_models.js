#!/usr/bin/env node
/**
 * Convert Azure's two semi-structured region-availability JSON files into
 * index.html's Azure `models[]` shape ({g,n,v,card,s,offer,lifecycle,...}),
 * then optionally patch in lifecycle data. Does NOT touch index.html itself --
 * write its output to a models.json (and groups.json) and feed those into
 * apply_update.js replace-models, same as every other provider's pipeline.
 *
 * Why this exists: azure-model-openai-ava.json and azure-model-others-ava.json
 * are pre-extracted (fetch_doc.sh + hand-parsing), but turning them into the
 * page's models[] shape -- building the 8-bit region bitmask, inferring which
 * `g` (publisher) each model belongs to, constructing the `offer` badge text,
 * and de-duplicating models that appear in BOTH files -- used to be redone by
 * hand every refresh. This script codifies that logic so it's a one-command
 * step instead of a from-scratch derivation.
 *
 * IMPORTANT -- read before running:
 *
 * 1. azure-model-openai-ava.json is NOT limited to OpenAI. Its `standard` /
 *    `provisioned` / `batch` trees each have an `openai` category AND an
 *    `other_sold_by_azure` (and sometimes `other_model_collections`) category.
 *    Those "other" categories cover models Azure sells DIRECTLY (not via
 *    third-party marketplace billing) from other publishers -- observed so
 *    far: DeepSeek, Cohere (rerank v4 / command-a), Black Forest Labs (FLUX),
 *    Moonshot AI (Kimi), xAI (grok), Meta (Llama-3.3 / Llama-4-Maverick),
 *    Microsoft (MAI-Image, Phi-4 family), Mistral (Mistral-Large-3,
 *    mistral-medium-3-5). Group (`g`) is inferred from the model name prefix
 *    for these -- see inferGroup() below -- since the source JSON doesn't
 *    label a publisher directly. If a genuinely new publisher shows up under
 *    "other_sold_by_azure" that inferGroup() doesn't recognize, it's tagged
 *    "UNKNOWN:<model name>" and printed to stderr -- add a rule rather than
 *    letting it silently land in the wrong group.
 *
 * 2. azure-model-others-ava.json (the third-party MARKETPLACE / serverless
 *    scrape, e.g. Anthropic, Meta, Mistral, Cohere, NTT DATA) can legitimately
 *    overlap with (1) for the same model -- e.g. the Phi-4 family shows up on
 *    the "from-partners" page with offer_availability_region "Not applicable"
 *    and no region matrix (it's not sold via that channel), while
 *    azure-model-openai-ava.json's other_sold_by_azure category has real
 *    region data for the same models. When both files have an entry for the
 *    same (g, n), this script PREFERS the openai-ava.json version and drops
 *    the others-ava.json placeholder -- don't "fix" this into a merge, the
 *    other_sold_by_azure data is the one with actual region support.
 *
 * 3. Models with an empty region matrix in others-ava.json (no Global
 *    Standard / Data Zone Standard row for that model at all -- common for
 *    embeddings, gated-preview models, and open-weight legacy models) are
 *    still emitted, with `s: {}` (renders with no availability dots) and a
 *    `note` field explaining why. Don't drop them; the model still exists in
 *    the catalog and the "no data on this page" fact is itself useful.
 *
 * 4. Some providers have NO data in either file (observed: Nixtla, Stability
 *    AI). If index.html currently has those groups and neither source file
 *    covers them, this script's output simply won't include them --
 *    replace-models will report them as "removed". That's expected unless a
 *    3rd source is added; don't treat it as a bug in this script.
 *
 * Usage:
 *   node build_azure_models.js \
 *     --openai azure-model-openai-ava.json \
 *     --others azure-model-others-ava.json \
 *     --retirement azure-model-retirement.json \
 *     --out-models azure-models-built.json \
 *     --out-groups azure-groups-built.json
 *
 *   node apply_update.js replace-models index.html azure azure-models-built.json \
 *     --out index-new.html --groups azure-groups-built.json --generated YYYY-MM-DD
 */
const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.openai || !args.others || !args['out-models']) {
  console.error('usage: build_azure_models.js --openai <openai-ava.json> --others <others-ava.json> --out-models <out.json> [--retirement <retirement.json>] [--out-groups <out.json>]');
  process.exit(1);
}

const CAP_BITS = { gs: 1, dzs: 2, std: 4, gpm: 8, dzpm: 16, rpm: 32, gb: 64, dzb: 128 };

// Azure's full region list (code -> display name). Kept here rather than read
// from index.html so this script has no dependency on the page itself.
const REGIONS = {
  brazilsouth: 'Brazil South', canadacentral: 'Canada Central', canadaeast: 'Canada East',
  centralus: 'Central US', eastus: 'East US', eastus2: 'East US 2',
  northcentralus: 'North Central US', southcentralus: 'South Central US',
  westcentralus: 'West Central US', westus: 'West US', westus2: 'West US 2', westus3: 'West US 3',
  francecentral: 'France Central', germanywestcentral: 'Germany West Central', italynorth: 'Italy North',
  norwayeast: 'Norway East', polandcentral: 'Poland Central', spaincentral: 'Spain Central',
  swedencentral: 'Sweden Central', switzerlandnorth: 'Switzerland North', switzerlandwest: 'Switzerland West',
  uksouth: 'UK South', ukwest: 'UK West', westeurope: 'West Europe',
  australiaeast: 'Australia East', japaneast: 'Japan East', japanwest: 'Japan West',
  koreacentral: 'Korea Central', southeastasia: 'Southeast Asia', southindia: 'South India',
  southafricanorth: 'South Africa North', uaenorth: 'UAE North',
};
const NAME_TO_CODE = Object.fromEntries(Object.entries(REGIONS).map(([code, name]) => [name, code]));

const OPENAI_OFFER = { label: 'Global', short: 'Global', detail: 'Sold directly by Azure — globally available.' };
const GLOBAL_OFFER = { label: 'Global', short: 'Global', detail: 'Offer available globally (no marketplace region restriction).' };
// The Microsoft-managed marketplace country list is presentation data that
// belongs to the page, not something scraped fresh each run -- confirm it
// still matches an existing "Microsoft-managed" offer.detail in index.html
// before trusting this constant on a new run (Microsoft adds countries to
// this program occasionally).
const MS_MANAGED_BASE = ["Armenia","Australia","Austria","Bahrain","Barbados","Belarus","Bulgaria","Belgium","Cambodia","Canada","Chile","Colombia","Croatia","Cyprus","Czechia","Denmark","Egypt","Estonia","Finland","France","Germany","Georgia","Greece","Hungary","Iceland","Indonesia","Ireland","Italy","Kenya","Latvia","Liechtenstein","Lithuania","Luxembourg","Malaysia","Malta","Moldova","Monaco","Netherlands","New Zealand","Nigeria","Norway","Oman","Philippines","Poland","Portugal","Romania","Russia","Saudi Arabia","Serbia","Singapore","Slovakia","Slovenia","South Africa","South Korea","Spain","Sweden","Switzerland","Taiwan","Tajikistan","Thailand","Türkiye","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States including Puerto Rico","Uzbekistan","Vietnam"];

function msManagedOffer(exclude, includeAdditional) {
  exclude = exclude || []; includeAdditional = includeAdditional || [];
  let detail = `Microsoft-managed countries/regions (${MS_MANAGED_BASE.length}): ${MS_MANAGED_BASE.join(', ')}.`;
  let short = 'MS-managed';
  if (exclude.length) { detail += ` Except: ${exclude.join(', ')}.`; short += ` −${exclude.length}`; }
  if (includeAdditional.length) { detail += ` Plus: ${includeAdditional.join(', ')}.`; short += ` +${includeAdditional.length}`; }
  return { label: 'Microsoft-managed', short, detail, extra: includeAdditional, except: exclude };
}

function inferGroup(name, category) {
  if (category === 'openai') return 'OpenAI';
  if (/^DeepSeek/i.test(name)) return 'DeepSeek';
  if (/^Cohere/i.test(name)) return 'Cohere';
  if (/^FLUX/i.test(name)) return 'Black Forest Labs';
  if (/^Kimi/i.test(name)) return 'Moonshot AI';
  if (/^grok/i.test(name)) return 'xAI';
  if (/^Llama/i.test(name)) return 'Meta Llama';
  if (/^MAI-|^Phi-4/i.test(name)) return 'Microsoft';
  if (/^Mistral/i.test(name)) return 'Mistral';
  return 'UNKNOWN:' + name;
}

// ---- Convert azure-model-openai-ava.json (openai + other_sold_by_azure + other_model_collections) ----
const oa = JSON.parse(fs.readFileSync(args.openai, 'utf8'));
const DEPLOY_BIT = {
  'standard.global': 'gs', 'standard.data_zone': 'dzs', 'standard.regional': 'std',
  'provisioned.global': 'gpm', 'provisioned.data_zone': 'dzpm', 'provisioned.regional': 'rpm',
  'batch.global': 'gb', 'batch.data_zone': 'dzb',
};

const oaMap = new Map(); // key g|n|v -> {g,n,v,s,category}
for (const [deployKey, bitKey] of Object.entries(DEPLOY_BIT)) {
  const [deployType, scope] = deployKey.split('.');
  const node = oa[deployType] && oa[deployType][scope];
  if (!node) continue;
  for (const [catName, catNode] of Object.entries(node.categories || {})) {
    for (const items of Object.values(catNode.tabs || {})) {
      for (const item of items) {
        const g = inferGroup(item.model, catName);
        const v = item.version || null;
        const key = `${g}|${item.model}|${v}`;
        if (!oaMap.has(key)) oaMap.set(key, { g, n: item.model, v, s: {}, category: catName });
        const rec = oaMap.get(key);
        const bit = CAP_BITS[bitKey];
        for (const [region, avail] of Object.entries(item.regions || {})) {
          if (avail) rec.s[region] = (rec.s[region] || 0) | bit;
        }
      }
    }
  }
}

const oaModels = [...oaMap.values()].map((rec) => ({
  g: rec.g, n: rec.n, v: rec.v, card: null, s: rec.s,
  offer: rec.category === 'openai' ? OPENAI_OFFER : GLOBAL_OFFER,
}));

const unknownGroups = oaModels.filter((m) => m.g.startsWith('UNKNOWN:'));
if (unknownGroups.length) {
  console.error('!! UNKNOWN group inference -- add a rule to inferGroup() for:', unknownGroups.map((m) => m.n));
}

// ---- Convert azure-model-others-ava.json, merging across entries first (a
// model can legitimately appear in more than one deployment-type entry, e.g.
// Anthropic's Global Standard AND Data Zone Standard groupings) ----
const covered = new Set(oaModels.map((m) => `${m.g}|${m.n}`));
const ot = JSON.parse(fs.readFileSync(args.others, 'utf8'));
const G_MAP = { Anthropic: 'Anthropic', Cohere: 'Cohere', Meta: 'Meta Llama', Microsoft: 'Microsoft', Mistral: 'Mistral', 'NTT DATA': 'NTT DATA' };
const DEPLOY_TYPE_BIT = { 'Global Standard': CAP_BITS.gs, 'Data Zone Standard (US)': CAP_BITS.dzs };

const otMap = new Map(); // key g|n -> {g,n,v,s,offer,note}
for (const entry of ot) {
  const g = G_MAP[entry.provider] || entry.provider;
  const oar = entry.offer_availability_region || {};
  let offer = null;
  if ('raw' in oar) offer = null;
  else if (oar.base === 'Microsoft Managed Countries/Regions') offer = msManagedOffer(oar.exclude, oar.include_additional);
  else if (oar.base === 'US') offer = { label: 'US', short: 'US', detail: 'Available for Data Zone Standard hosted in the US.' };

  const bit = DEPLOY_TYPE_BIT[entry.deployment_type] || null;
  for (const n of entry.models) {
    const key = `${g}|${n}`;
    if (!otMap.has(key)) otMap.set(key, { g, n, v: null, card: null, s: {}, offer, note: entry.note });
    const rec = otMap.get(key);
    if (bit && Array.isArray(entry.hub_project_region_deployment)) {
      for (const regionName of entry.hub_project_region_deployment) {
        const code = NAME_TO_CODE[regionName];
        if (code) rec.s[code] = (rec.s[code] || 0) | bit;
        else console.error('!! unknown region display name in others-ava file:', regionName);
      }
    }
    if (!rec.offer && offer) rec.offer = offer;
    if (!rec.note && entry.note) rec.note = entry.note;
  }
}

const otModels = [];
const skippedDup = [];
for (const [key, rec] of otMap) {
  if (covered.has(key)) { skippedDup.push(key); continue; }
  const model = { g: rec.g, n: rec.n, v: rec.v, card: rec.card, s: rec.s, offer: rec.offer };
  if (rec.note) model.note = rec.note;
  otModels.push(model);
}

console.error(`OA (openai + sold-directly) models: ${oaModels.length} | others-ava unique models: ${otMap.size} | added: ${otModels.length} | skipped as dup of OA (OA preferred): ${skippedDup.length}`);
if (skippedDup.length) console.error('  dup keys:', skippedDup);

const allModels = [...oaModels, ...otModels];

// ---- Optional: patch lifecycle/retirementDate/replacement from azure-model-retirement.json ----
if (args.retirement) {
  const retire = JSON.parse(fs.readFileSync(args.retirement, 'utf8'));
  function normSlug(str) {
    return str.toLowerCase().replace(/\(.*?\)/g, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  const retireLookup = new Map();
  const retireSlugLookup = new Map();
  for (const section of retire.sections) {
    for (const m of section.models) {
      retireLookup.set(`${m.model}|${m.version || ''}`, m);
      retireLookup.set(`${m.model}|`, m);
      const slug = normSlug(m.model);
      if (!retireSlugLookup.has(slug)) retireSlugLookup.set(slug, m);
    }
  }
  let patched = 0;
  for (const model of allModels) {
    // Some Azure docs (e.g. Anthropic's retirement section) use API slug
    // names ("claude-opus-4-6") while the region-availability pages use
    // display names ("Claude Opus 4.6") -- the slug-normalized lookup is the
    // fallback that bridges that mismatch. Don't remove it even though the
    // exact-match lookups cover most providers.
    const src = retireLookup.get(`${model.n}|${model.v || ''}`) || retireLookup.get(`${model.n}|`) || retireSlugLookup.get(normSlug(model.n));
    if (src) {
      model.lifecycle = src.lifecycle;
      model.retirementDate = src.retirement_date;
      model.replacement = src.replacement;
      patched++;
    }
  }
  console.error(`Lifecycle-patched: ${patched}/${allModels.length}`);
}

// ---- Groups ----
const KNOWN_GROUP_ORDER = ['OpenAI', 'Anthropic', 'Black Forest Labs', 'Cohere', 'DeepSeek', 'Meta Llama', 'Microsoft', 'Mistral', 'Moonshot AI', 'NTT DATA', 'Nixtla', 'Stability AI', 'xAI'];
const present = new Set(allModels.map((m) => m.g));
const groups = KNOWN_GROUP_ORDER.filter((g) => present.has(g));
const extra = [...present].filter((g) => !KNOWN_GROUP_ORDER.includes(g));
if (extra.length) { console.error('!! groups not in KNOWN_GROUP_ORDER, appending (consider updating the constant):', extra); groups.push(...extra); }

fs.writeFileSync(args['out-models'], JSON.stringify(allModels, null, 2));
console.error(`Wrote ${args['out-models']} (${allModels.length} models)`);
if (args['out-groups']) {
  fs.writeFileSync(args['out-groups'], JSON.stringify(groups, null, 2));
  console.error(`Wrote ${args['out-groups']} (${groups.join(', ')})`);
}

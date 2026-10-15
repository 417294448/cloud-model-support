#!/usr/bin/env node
// Rebuild azure-model-others-ava.json from the freshly fetched
// models-from-partners page. Semi-structured: provider capability tables
// (Model/Type/Capabilities/Offer availability region) give provider + offer;
// the "Region availability by deployment type" tables (H3 Global standard /
// Data Zone Standard) give per-model region deployment lists.
const fs = require('fs');

const HTML = process.env.AZURE_OTHERS_HTML || '/tmp/azure-others-ava.html';
const OUT = process.env.AZURE_OTHERS_OUT || '/tmp/azure-others-ava-built.json';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners';

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
const PROVIDER_NAME_MAP = { 'Mistral AI': 'Mistral', 'NTT Data': 'NTT DATA' };

function cellText(c) {
  c = c.replace(/<img[^>]*icon-yes[^>]*>/gi, 'YES').replace(/<img[^>]*icon-no[^>]*>/gi, 'NO');
  return c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

const html = fs.readFileSync(HTML, 'utf8');

const headings = [];
for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) headings.push({ pos: m.index, level: +m[1], text: cellText(m[2]) });
const tables = [];
for (const m of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
  const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
    [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1])));
  tables.push({ pos: m.index, rows });
}
function nearest(pos, level) {
  let n = null;
  for (const h of headings) { if (h.pos < pos && h.level === level) n = h; else if (h.pos >= pos) break; }
  return n ? n.text : null;
}

const issues = [];

// ---- offer cell -> structured shape (mirrors how the committed file stores it) ----
function parseOffer(cell) {
  const t = (cell || '').trim();
  if (t === 'Not applicable' || t === '-') return { raw: t };
  if (t.startsWith('Microsoft Managed Countries/Regions')) {
    let rest = t.slice('Microsoft Managed Countries/Regions'.length).trim();
    let exclude = [];
    const em = rest.match(/^\(except\s+(.*?)\)/i);
    if (em) {
      exclude = em[1].split(/\s+and\s+|\s*,\s*|\s+/).filter(Boolean);
      rest = rest.slice(em[0].length).trim();
    }
    const include_additional = rest ? rest.split(/\s+/).filter(Boolean) : [];
    return { base: 'Microsoft Managed Countries/Regions', exclude, include_additional };
  }
  if (/^US$/i.test(t)) return { base: 'US', exclude: [], include_additional: [] };
  return { raw: t };
}

function titleSlug(slug) {
  const parts = slug.split('-');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (/^\d+$/.test(parts[i])) {
      let num = parts[i];
      while (i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) num += '.' + parts[++i];
      out.push(num);
    } else out.push(parts[i].charAt(0).toUpperCase() + parts[i].slice(1));
  }
  return out.join(' ');
}

const CAP_HEADER = ['Model', 'Type', 'Capabilities', 'Offer availability region'];
function isCapTable(t) { return t.rows[0] && t.rows[0].length === 4 && CAP_HEADER.every((h, i) => t.rows[0][i] === h); }
function isRegionTable(t) { return t.rows[0] && t.rows[0].length > 2 && t.rows[0][0] === 'Model' && t.rows[0][1] === 'Version'; }

// ---- provider capability tables (ordered as on page) ----
const providerOrder = [];
const providerModels = new Map(); // provider -> [{name, offer}]
for (const t of tables) {
  if (!isCapTable(t)) continue;
  let provider = nearest(t.pos, 2);
  if (!provider) { issues.push('capability table without H2'); continue; }
  provider = PROVIDER_NAME_MAP[provider] || provider;
  if (!providerModels.has(provider)) { providerModels.set(provider, []); providerOrder.push(provider); }
  for (let i = 1; i < t.rows.length; i++) {
    const row = t.rows[i];
    if (!row[0]) continue;
    const name = row[0].replace(/\s+\d+$/, '').trim(); // strip footnote marker
    providerModels.get(provider).push({ name, offer: parseOffer(row[3]) });
  }
}

// ---- region tables: model(kind) -> Set(region display names), plus DZ membership ----
const regionGlobal = new Map();
const regionDZ = new Map();
for (const t of tables) {
  if (!isRegionTable(t)) continue;
  const h3 = nearest(t.pos, 3);
  const kind = h3 === 'Global standard' ? 'global' : h3 === 'Data Zone Standard' ? 'dz' : null;
  if (!kind) { issues.push(`region table under unknown H3: ${h3}`); continue; }
  const header = t.rows[0];
  const regionCols = header.slice(2);
  for (let i = 1; i < t.rows.length; i++) {
    const row = t.rows[i];
    if (!row[0]) continue;
    const key = row[0].toLowerCase();
    const target = kind === 'global' ? regionGlobal : regionDZ;
    if (!target.has(key)) target.set(key, new Set());
    regionCols.forEach((rc, ci) => {
      const v = row[ci + 2] || '';
      if (v.includes('\u2705') || /^yes$/i.test(v) || v === '\u2713' || v === '\u2714') {
        const disp = REGIONS[rc];
        if (disp) target.get(key).add(disp);
        else issues.push(`unknown region code: ${rc}`);
      }
    });
  }
}

// ---- how a display name maps to a region-table key (Anthropic uses slugs) ----
function displayKey(provider, name) {
  if (provider === 'Anthropic') return name.toLowerCase().replace(/\s+/g, '-').replace(/\./g, '-');
  return name.toLowerCase();
}
function inferProvider(name) {
  if (/^Llama/i.test(name)) return 'Meta';
  if (/^Mistral/i.test(name)) return 'Mistral';
  if (/^Cohere/i.test(name)) return 'Cohere';
  if (/^Phi-4|^MAI-/i.test(name)) return 'Microsoft';
  if (/^tsuzumi/i.test(name)) return 'NTT DATA';
  return null;
}
const sortRegions = (s) => [...s].sort();

const entries = [];
const seenKeys = new Set();
function buildEntry(provider, displayName, offer, kind) {
  const rk = displayKey(provider, displayName);
  const globalSet = regionGlobal.get(rk) || new Set();
  const dzSet = regionDZ.get(rk) || new Set();
  const hub = kind === 'dz' ? new Set([...globalSet, ...dzSet]) : globalSet;
  const regionList = sortRegions(hub);
  const e = {
    provider,
    deployment_type: kind === 'dz' ? 'Data Zone Standard (US)' : 'Global Standard',
    models: [displayName],
    offer_availability_region: kind === 'dz' ? { base: 'US', exclude: [], include_additional: [] } : offer,
    hub_project_region_deployment: regionList,
  };
  if (!regionList.length) e.note = 'No region matrix data available on this page for this model/deployment type.';
  return e;
}

for (const provider of providerOrder) {
  for (const m of providerModels.get(provider)) {
    const displayName = provider === 'Anthropic' ? titleSlug(m.name) : m.name;
    const rk = displayKey(provider, displayName);
    entries.push(buildEntry(provider, displayName, m.offer, 'global'));
    seenKeys.add(rk);
    if (regionDZ.has(rk)) {
      entries.push(buildEntry(provider, displayName, m.offer, 'dz'));
      seenKeys.add(rk);
    }
  }
}

// ---- region-table-only models (e.g. Mistral-large): infer provider + reuse its offer ----
for (const key of new Set([...regionGlobal.keys(), ...regionDZ.keys()])) {
  if (seenKeys.has(key)) continue;
  const provider = inferProvider(key);
  if (!provider) { issues.push(`region-only model with unknown provider: ${key}`); continue; }
  const cap = providerModels.get(provider) || [];
  const withBase = cap.find((x) => x.offer && x.offer.base);
  const offer = withBase ? withBase.offer : (cap[0] ? cap[0].offer : { raw: '-' });
  let displayName = key;
  if (provider === 'Anthropic') displayName = titleSlug(key);
  else displayName = key.replace(/^mistral/, 'Mistral').replace(/^llama/, 'Llama');
  entries.push(buildEntry(provider, displayName, offer, 'global'));
  if (regionDZ.has(key)) entries.push(buildEntry(provider, displayName, offer, 'dz'));
}

fs.writeFileSync(OUT, JSON.stringify(entries, null, 2) + '\n');
console.log('wrote', OUT, entries.length, 'entries');
if (issues.length) console.log('issues:\n' + issues.join('\n'));

// ---- diff vs committed file ----
const oldPath = '/workspace/azure-model-others-ava.json';
if (fs.existsSync(oldPath)) {
  const oldJ = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  const key = (e) => `${e.provider}|${e.deployment_type}|${e.models.join(',')}`;
  const a = new Map(oldJ.map((e) => [key(e), e]));
  const b = new Map(entries.map((e) => [key(e), e]));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)));
  console.log(`entries: ${a.size} -> ${b.size}`);
  console.log(`added (${added.length}): ${added.join('; ') || '(none)'}`);
  console.log(`removed (${removed.length}): ${removed.join('; ') || '(none)'}`);
  console.log(`changed (${changed.length}):`);
  for (const k of changed.slice(0, 40)) console.log(`  ${k}\n    old ${JSON.stringify(a.get(k))}\n    new ${JSON.stringify(b.get(k))}`);
}

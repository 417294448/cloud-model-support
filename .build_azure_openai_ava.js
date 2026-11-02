#!/usr/bin/env node
// Rebuild azure-model-openai-ava.json from the freshly fetched
// models-sold-directly-by-azure-region-availability page.
//
// The page renders as:  H2 deployment type  ->  H4 category (Azure OpenAI /
// other Foundry Models sold by Azure)  ->  a tab group with 4 region tabs
// (Americas / Europe / Asia Pacific / Middle East and Africa). Every table lives
// inside a <div id="tabpanel_<n>_az-<region>">, so the enclosing tabpanel id +
// the nearest preceding H2/H4 headings give every table an unambiguous
// (deployment, category, region) home -- no guessing at a 41-table regex match.
const fs = require('fs');

const HTML = '/tmp/azure-openai-ava.html';
const OUT = '/tmp/azure-openai-ava-built.json';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry-classic/foundry-models/concepts/models-sold-directly-by-azure-region-availability';

const TAB_NAMES = {
  'az-americas': 'Americas',
  'az-europe': 'Europe',
  'az-apac': 'Asia Pacific',
  'az-mea': 'Middle East and Africa',
};

const DEPLOYMENTS = {
  'Global Standard': ['standard', 'global'],
  'Data Zone Standard': ['standard', 'data_zone'],
  'Standard/Regional': ['standard', 'regional'],
  'Global Provisioned Managed': ['provisioned', 'global'],
  'Data Zone Provisioned Managed': ['provisioned', 'data_zone'],
  'Regional Provisioned Managed': ['provisioned', 'regional'],
  'Global Batch': ['batch', 'global'],
  'Data Zone Batch': ['batch', 'data_zone'],
};

const CATEGORIES = {
  'Availability for Azure OpenAI in Foundry Models': 'openai',
  'Availability for other Foundry Models sold by Azure': 'other_sold_by_azure',
};

function cellText(c) {
  return c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

const html = fs.readFileSync(HTML, 'utf8');

// ordered marks: headings and tabpanels
const marks = [];
for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
  marks.push({ pos: m.index, kind: 'h' + m[1], text: cellText(m[2]) });
}
for (const m of html.matchAll(/<(?:section|div)[^>]*id="(tabpanel_[0-9]+_az-[a-z]+)"/gi)) {
  marks.push({ pos: m.index, kind: 'tabpanel', id: m[1] });
}
marks.sort((a, b) => a.pos - b.pos);

const out = { source: SOURCE, standard: {}, provisioned: {}, batch: {} };
const issues = [];

let curDep = null;   // [group, kind]
let curCat = null;   // category key

function ensure(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur[k]) cur[k] = { title: null, categories: {} };
    cur = cur[k];
  }
  return cur;
}

for (let i = 0; i < marks.length; i++) {
  const mk = marks[i];
  if (mk.kind === 'h2') {
    if (DEPLOYMENTS[mk.text]) curDep = DEPLOYMENTS[mk.text];
    curCat = null;
    continue;
  }
  if (mk.kind === 'h4') {
    if (CATEGORIES[mk.text]) curCat = CATEGORIES[mk.text];
    continue;
  }
  if (mk.kind !== 'tabpanel') continue;

  if (!curDep) { issues.push(`tabpanel ${mk.id} before any deployment heading`); continue; }
  const tabMatch = mk.id.match(/_az-(americas|europe|apac|mea)$/);
  const tabName = TAB_NAMES['az-' + tabMatch[1]];

  const sliceEnd = marks.slice(i + 1).find(x => x.kind === 'tabpanel');
  const chunk = html.slice(mk.pos, sliceEnd ? sliceEnd.pos : html.length);
  const tm = chunk.match(/<table[\s\S]*?<\/table>/i);
  if (!tm) continue; // empty tab is legitimate

  const rows = [...tm[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(r =>
    [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => cellText(c[1]))
  );
  if (rows.length < 1) { issues.push(`empty table in ${mk.id}`); continue; }
  const header = rows[0];
  const regionCols = header.slice(2);

  const dep = ensure(out, [curDep[0], curDep[1]]);
  dep.title = header.length ? dep.title : dep.title; // title set below from H2 text is not tracked; fill from map
  if (!curCat) { issues.push(`${mk.id}: no category heading`); continue; }
  if (!dep.categories[curCat]) dep.categories[curCat] = { title: null, tabs: {} };
  if (dep.categories[curCat].tabs[tabName]) issues.push(`duplicate tab ${curDep.join('.')} / ${curCat} / ${tabName}`);

  const models = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 2 || !row[0]) continue;
    const regions = {};
    regionCols.forEach((rc, ci) => {
      const v = row[ci + 2] || '';
      regions[rc] = v.includes('\u2705') || /^yes$/i.test(v) || v === '\u2713' || v === '\u2714';
    });
    models.push({ model: row[0], version: row[1] || null, regions });
  }
  dep.categories[curCat].tabs[tabName] = models;
}

// backfill titles from a static map (matches the source headings verbatim)
const DEP_TITLES = {
  'standard.global': 'Global Standard',
  'standard.data_zone': 'Data Zone Standard',
  'standard.regional': 'Standard/Regional',
  'provisioned.global': 'Global Provisioned Managed',
  'provisioned.data_zone': 'Data Zone Provisioned Managed',
  'provisioned.regional': 'Regional Provisioned Managed',
  'batch.global': 'Global Batch',
  'batch.data_zone': 'Data Zone Batch',
};
const CAT_TITLES = {
  openai: 'Availability for Azure OpenAI in Foundry Models',
  other_sold_by_azure: 'Availability for other Foundry Models sold by Azure',
};

// canonical key ordering
const ordered = { source: SOURCE };
for (const grp of ['standard', 'provisioned', 'batch']) {
  ordered[grp] = {};
  for (const kind of ['global', 'data_zone', 'regional']) {
    if (!out[grp][kind]) continue;
    ordered[grp][kind] = { title: DEP_TITLES[grp + '.' + kind], categories: {} };
    for (const cat of ['openai', 'other_sold_by_azure']) {
      if (!out[grp][kind].categories[cat]) continue;
      ordered[grp][kind].categories[cat] = { title: CAT_TITLES[cat], tabs: out[grp][kind].categories[cat].tabs };
    }
  }
}

fs.writeFileSync(OUT, JSON.stringify(ordered, null, 2) + '\n');
console.log('wrote', OUT);
if (issues.length) console.log('issues:\n' + issues.join('\n'));

// compare against the existing file
const oldPath = '/workspace/azure-model-openai-ava.json';
if (fs.existsSync(oldPath)) {
  const oldJ = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  const flat = (j) => {
    const map = new Map();
    for (const grp of ['standard', 'provisioned', 'batch']) {
      if (!j[grp]) continue;
      for (const kind of Object.keys(j[grp])) {
        const cats = j[grp][kind].categories || {};
        for (const cat of Object.keys(cats)) {
          const tabs = cats[cat].tabs || {};
          for (const tab of Object.keys(tabs)) {
            for (const e of tabs[tab]) map.set(`${grp}.${kind}|${cat}|${tab}|${e.model}|${e.version}`, e.regions);
          }
        }
      }
    }
    return map;
  };
  const a = flat(oldJ), b = flat(ordered);
  const added = [...b.keys()].filter(k => !a.has(k));
  const removed = [...a.keys()].filter(k => !b.has(k));
  const changed = [...b.keys()].filter(k => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)));
  console.log(`entries: ${a.size} -> ${b.size}`);
  console.log(`added (${added.length}): ${added.slice(0, 30).join('; ') || '(none)'}`);
  console.log(`removed (${removed.length}): ${removed.slice(0, 30).join('; ') || '(none)'}`);
  console.log(`changed regions (${changed.length}): ${changed.slice(0, 30).join('; ') || '(none)'}`);
}

// Re-scrape azure-model-openai-ava.json from
// docs: models-sold-directly-by-azure-region-availability
// (heading-driven: h2 = deployment type, h4 = category, table order/region columns = tab)
const fs = require('fs');

const HTML = '/tmp/azure-openai-ava.html';
const OUT = 'azure-model-openai-ava-new.json';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry-classic/foundry-models/concepts/models-sold-directly-by-azure-region-availability';

const CONTINENT = {
  Americas: ['brazilsouth', 'canadacentral', 'canadaeast', 'centralus', 'eastus', 'eastus2', 'northcentralus', 'southcentralus', 'westcentralus', 'westus', 'westus2', 'westus3'],
  Europe: ['francecentral', 'germanywestcentral', 'italynorth', 'northeurope', 'norwayeast', 'polandcentral', 'spaincentral', 'swedencentral', 'switzerlandnorth', 'switzerlandwest', 'uksouth', 'ukwest', 'westeurope'],
  'Asia Pacific': ['australiaeast', 'japaneast', 'japanwest', 'koreacentral', 'southeastasia', 'southindia'],
  'Middle East and Africa': ['southafricanorth', 'uaenorth'],
};
const REGION_CONTINENT = {};
for (const [c, arr] of Object.entries(CONTINENT)) for (const r of arr) REGION_CONTINENT[r] = c;

const DEPLOY = {
  'Global Standard': ['standard', 'global', 'Global Standard'],
  'Data Zone Standard': ['standard', 'data_zone', 'Data Zone Standard'],
  'Standard/Regional': ['standard', 'regional', 'Standard/Regional'],
  'Global Provisioned Managed': ['provisioned', 'global', 'Global Provisioned Managed'],
  'Data Zone Provisioned Managed': ['provisioned', 'data_zone', 'Data Zone Provisioned Managed'],
  'Regional Provisioned Managed': ['provisioned', 'regional', 'Regional Provisioned Managed'],
  'Global Batch': ['batch', 'global', 'Global Batch'],
  'Data Zone Batch': ['batch', 'data_zone', 'Data Zone Batch'],
};
const CATEGORY = {
  'Availability for Azure OpenAI in Foundry Models': ['openai', 'Availability for Azure OpenAI in Foundry Models'],
  'Availability for other Foundry Models sold by Azure': ['other_sold_by_azure', 'Availability for other Foundry Models sold by Azure'],
};

function cellText(c) {
  return c
    .replace(/<code>/gi, ' ').replace(/<\/code>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

const html = fs.readFileSync(HTML, 'utf8');
const marks = [];
for (const m of html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)) marks.push({ pos: m.index, type: 'h2', text: cellText(m[1]) });
for (const m of html.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)) marks.push({ pos: m.index, type: 'h4', text: cellText(m[1]) });
for (const m of html.matchAll(/<table[\s\S]*?<\/table>/g)) marks.push({ pos: m.index, type: 'table', html: m[0] });
marks.sort((a, b) => a.pos - b.pos);

const out = { source: SOURCE };
let curH2 = null;
let curH4 = null;
const problems = [];

for (const mark of marks) {
  if (mark.type === 'h2') { curH2 = mark.text; curH4 = null; continue; }
  if (mark.type === 'h4') { curH4 = mark.text; continue; }
  if (!curH2 || !DEPLOY[curH2]) continue;
  if (!curH4 || !CATEGORY[curH4]) { problems.push(['unmapped heading', curH2, curH4]); continue; }

  const rows = [...mark.html.matchAll(/<tr[\s\S]*?<\/tr>/g)]
    .map((r) => [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1])));
  const header = rows[0];
  const regionCols = header.slice(2);
  const continents = new Set(regionCols.map((r) => REGION_CONTINENT[r]));
  if (continents.size !== 1) { problems.push(['ambiguous tab', curH2, curH4, regionCols.join(',')]); continue; }
  const tab = [...continents][0];
  if (!tab) { problems.push(['unknown region column', curH2, curH4, regionCols.join(',')]); continue; }

  const [deployType, scope, deployTitle] = DEPLOY[curH2];
  const [catKey, catTitle] = CATEGORY[curH4];
  out[deployType] = out[deployType] || {};
  out[deployType][scope] = out[deployType][scope] || { title: deployTitle, categories: {} };
  const cat = (out[deployType][scope].categories[catKey] = out[deployType][scope].categories[catKey] || { title: catTitle, tabs: {} });
  if (cat.tabs[tab]) problems.push(['duplicate tab table', curH2, catKey, tab]);

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue;
    const regions = {};
    regionCols.forEach((rc, j) => { regions[rc] = row[2 + j] === '✅'; });
    items.push({ model: row[0], version: row[1] || null, regions });
  }
  cat.tabs[tab] = items;
}

if (problems.length) { console.error('PROBLEMS:'); for (const p of problems) console.error('  ', JSON.stringify(p)); }

// summarize
for (const d of Object.keys(out)) {
  if (d === 'source') continue;
  for (const s of Object.keys(out[d])) {
    const cats = out[d][s].categories;
    console.log(d, s, '|', Object.entries(cats).map(([c, v]) => c + ': ' + Object.entries(v.tabs).map(([t, a]) => t.split(' ')[0] + '=' + a.length).join(',')).join(' | '));
  }
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('wrote', OUT);

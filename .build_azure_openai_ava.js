const fs = require('fs');
const HTML = '/tmp/azure-openai.html';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry-classic/foundry-models/concepts/models-sold-directly-by-azure-region-availability';

function cellText(c) {
  return c
    .replace(/<img[^>]*icon-yes[^>]*>/gi, 'YES')
    .replace(/<img[^>]*icon-no[^>]*>/gi, 'NO')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isAvailable(cell) {
  const u = cellText(cell).toUpperCase();
  return u === '✅' || u === 'YES' || u === 'TRUE' || u === 'Y' || u === 'AVAILABLE';
}

function extractHeadings(html) {
  const headings = [];
  const re = /<h([2-5])[^>]*>([\s\S]*?)<\/h\1>/g;
  let m;
  while ((m = re.exec(html))) {
    headings.push({
      level: parseInt(m[1], 10),
      pos: m.index,
      text: cellText(m[2])
    });
  }
  return headings;
}

function extractTables(html) {
  const headings = extractHeadings(html);
  function nearestHeading(pos, levelPredicate) {
    let nearest = null;
    for (const h of headings) {
      if (h.pos >= pos) break;
      if (levelPredicate(h.level)) nearest = h;
    }
    return nearest;
  }

  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = tableRe.exec(html))) {
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1]))
    );
    const deploy = nearestHeading(m.index, (lvl) => lvl === 2);
    const category = nearestHeading(m.index, (lvl) => lvl === 4);
    tables.push({ pos: m.index, deploy: deploy ? deploy.text : null, category: category ? category.text : null, rows });
  }
  return tables;
}

function detectTab(regionCodes) {
  const codes = new Set(regionCodes);
  if (codes.has('eastus') || codes.has('westus') || codes.has('centralus') || codes.has('brazilsouth')) return 'Americas';
  if (codes.has('francecentral') || codes.has('westeurope') || codes.has('uksouth') || codes.has('swedencentral')) return 'Europe';
  if (codes.has('australiaeast') || codes.has('japaneast') || codes.has('koreacentral') || codes.has('southeastasia')) return 'Asia Pacific';
  if (codes.has('southafricanorth') || codes.has('uaenorth')) return 'Middle East and Africa';
  return 'Other';
}

const DEPLOY_MAP = {
  'Global Standard': ['standard', 'global'],
  'Data Zone Standard': ['standard', 'data_zone'],
  'Standard/Regional': ['standard', 'regional'],
  'Global Provisioned Managed': ['provisioned', 'global'],
  'Data Zone Provisioned Managed': ['provisioned', 'data_zone'],
  'Regional Provisioned Managed': ['provisioned', 'regional'],
  'Global Batch': ['batch', 'global'],
  'Data Zone Batch': ['batch', 'data_zone']
};

const CATEGORY_MAP = {
  'Availability for Azure OpenAI in Foundry Models': 'openai',
  'Availability for other Foundry Models sold by Azure': 'other_sold_by_azure'
};

const CATEGORY_TITLE = {
  openai: 'Availability for Azure OpenAI in Foundry Models',
  other_sold_by_azure: 'Availability for other Foundry Models sold by Azure'
};

const DEPLOY_TITLE = {
  standard: { global: 'Global Standard', data_zone: 'Data Zone Standard', regional: 'Standard/Regional' },
  provisioned: { global: 'Global Provisioned Managed', data_zone: 'Data Zone Provisioned Managed', regional: 'Regional Provisioned Managed' },
  batch: { global: 'Global Batch', data_zone: 'Data Zone Batch' }
};

const output = { source: SOURCE, standard: {}, provisioned: {}, batch: {} };

const html = fs.readFileSync(HTML, 'utf8');
const tables = extractTables(html);

for (const t of tables) {
  if (!t.deploy || !DEPLOY_MAP[t.deploy]) continue;
  if (!t.category || !CATEGORY_MAP[t.category]) continue;
  const [deployType, scope] = DEPLOY_MAP[t.deploy];
  const catKey = CATEGORY_MAP[t.category];

  if (!output[deployType]) output[deployType] = {};
  if (!output[deployType][scope]) {
    output[deployType][scope] = { title: DEPLOY_TITLE[deployType][scope], categories: {} };
  }
  const node = output[deployType][scope];
  if (!node.categories[catKey]) {
    node.categories[catKey] = { title: CATEGORY_TITLE[catKey], tabs: {} };
  }

  const header = t.rows[0];
  if (header.length < 3) continue;
  const regionCodes = header.slice(2);
  const tab = detectTab(regionCodes);
  const items = [];
  for (let i = 1; i < t.rows.length; i++) {
    const row = t.rows[i];
    if (row.length < 3) continue;
    const model = row[0];
    const version = row[1];
    const regions = {};
    for (let j = 0; j < regionCodes.length; j++) {
      regions[regionCodes[j]] = isAvailable(row[2 + j]);
    }
    items.push({ model, version, regions });
  }
  if (!node.categories[catKey].tabs[tab]) node.categories[catKey].tabs[tab] = [];
  node.categories[catKey].tabs[tab].push(...items);
}

fs.writeFileSync('/workspace/azure-model-openai-ava.json', JSON.stringify(output, null, 2));

let total = 0;
for (const dt of ['standard', 'provisioned', 'batch']) {
  for (const scope of Object.keys(output[dt])) {
    for (const cat of Object.keys(output[dt][scope].categories)) {
      for (const tab of Object.keys(output[dt][scope].categories[cat].tabs)) {
        total += output[dt][scope].categories[cat].tabs[tab].length;
      }
    }
  }
}
console.log('total items:', total, 'tables parsed:', tables.filter(t => t.deploy && DEPLOY_MAP[t.deploy] && t.category && CATEGORY_MAP[t.category]).length);

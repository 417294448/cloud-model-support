const fs = require('fs');
const HTML = '/tmp/azure-others.html';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners';

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
    headings.push({ level: parseInt(m[1], 10), pos: m.index, text: cellText(m[2]) });
  }
  return headings;
}

function extractTables(html) {
  const headings = extractHeadings(html);
  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = tableRe.exec(html))) {
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1]))
    );
    // Find nearest preceding heading of any level
    let nearest = null;
    for (const h of headings) {
      if (h.pos >= m.index) break;
      nearest = h;
    }
    tables.push({ pos: m.index, heading: nearest ? nearest.text : null, level: nearest ? nearest.level : null, rows });
  }
  return tables;
}

function detectTab(regionCodes) {
  const codes = new Set(regionCodes);
  if (codes.has('eastus') || codes.has('westus') || codes.has('centralus') || codes.has('brazilsouth')) return 'Americas';
  if (codes.has('francecentral') || codes.has('westeurope') || codes.has('uksouth') || codes.has('swedencentral')) return 'Europe';
  if (codes.has('australiaeast') || codes.has('japaneast') || codes.has('koreacentral')) return 'Asia Pacific';
  if (codes.has('southafricanorth') || codes.has('uaenorth')) return 'Middle East and Africa';
  return 'Other';
}

const REGION_CODE_TO_NAME = {
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

function anthropicDisplayName(slug) {
  const parts = slug.split('-');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p) && i > 0 && /^\d+$/.test(parts[i - 1])) {
      out[out.length - 1] = out[out.length - 1] + '.' + p;
    } else {
      out.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  return out.join(' ');
}

function toDisplayName(provider, slug) {
  if (provider === 'Anthropic') return anthropicDisplayName(slug);
  return slug;
}

function parseMsManagedOffer(text) {
  const base = 'Microsoft Managed Countries/Regions';
  const rest = text.replace(/Microsoft Managed Countries\/Regions/i, '').trim();
  const exclude = [];
  const includeAdditional = [];
  const exceptMatch = rest.match(/\(except\s+([^)]+)\)/i);
  if (exceptMatch) {
    exclude.push(...exceptMatch[1].split(/,\s+|\s+and\s+/i).map(s => s.trim()).filter(Boolean));
  }
  const remaining = rest.replace(/\(except\s+[^)]+\)/i, '').trim();
  if (remaining) {
    includeAdditional.push(...remaining.split(/\s+/).map(s => s.trim()).filter(Boolean));
  }
  return { base, exclude, include_additional: includeAdditional };
}

function parseOfferRegion(text, deploymentType) {
  const t = text.trim();
  if (t === 'Not applicable') return { raw: 'Not applicable' };
  if (t === '-' || t === '—') return { raw: '-' };
  if (deploymentType === 'Data Zone Standard (US)') {
    return { base: 'US', exclude: [], include_additional: [] };
  }
  if (/Microsoft Managed Countries\/Regions/i.test(t)) {
    return parseMsManagedOffer(t);
  }
  return { raw: t };
}

function deploymentTypesFromOffer(text) {
  const t = text.trim();
  const types = [];
  const hasMsManaged = /Microsoft Managed Countries\/Regions/i.test(t);
  const hasDataZone = /Data Zone Standard/i.test(t) || /^US\b/i.test(t);
  if (hasMsManaged) types.push('Global Standard');
  if (hasDataZone) types.push('Data Zone Standard (US)');
  if (types.length === 0) types.push('Global Standard');
  return types;
}

const html = fs.readFileSync(HTML, 'utf8');
const tables = extractTables(html);
const headings = extractHeadings(html);

const KNOWN_PROVIDERS = new Set(['Anthropic', 'Cohere', 'Meta', 'Microsoft', 'Mistral AI', 'NTT Data']);
const PROVIDER_NAME_MAP = { 'Mistral AI': 'Mistral', 'NTT Data': 'NTT DATA' };

function providerForTable(t) {
  if (KNOWN_PROVIDERS.has(t.heading)) return t.heading;
  // Look for nearest preceding h2; only use it if it is a known provider
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h.pos >= t.pos) continue;
    if (h.level === 2) return KNOWN_PROVIDERS.has(h.text) ? h.text : null;
  }
  return null;
}

function deploymentTypeForTable(t) {
  if (!t.heading) return null;
  if (/Data Zone Standard/i.test(t.heading)) return 'Data Zone Standard (US)';
  if (/Global standard/i.test(t.heading)) return 'Global Standard';
  return null;
}

// Capability tables: those with a provider context and Model/Type/Capabilities/Offer availability region header
const records = [];
for (let ti = 0; ti < tables.length; ti++) {
  const t = tables[ti];
  const provider = providerForTable(t);
  if (!provider) continue;
  const header = t.rows[0];
  const idx = {};
  header.forEach((h, i) => {
    const u = h.toUpperCase();
    if (u.includes('MODEL')) idx.model = i;
    if (u.includes('OFFER')) idx.offer = i;
  });
  if (idx.model === undefined) continue;
  for (let i = 1; i < t.rows.length; i++) {
    const row = t.rows[i];
    if (row.length < 2) continue;
    const raw = row[idx.model] || '';
    const offerText = row[idx.offer] || '';
    const parts = raw.split(/\s+/);
    let version = '';
    let slug = raw;
    if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
      version = parts.pop();
      slug = parts.join(' ');
    }
    const display = toDisplayName(provider, slug);
    const mappedProvider = PROVIDER_NAME_MAP[provider] || provider;
    const types = deploymentTypesFromOffer(offerText);
    for (const dt of types) {
      records.push({
        provider: mappedProvider,
        deployment_type: dt,
        model_slug: slug,
        display_name: display,
        version,
        offer_region: parseOfferRegion(offerText, dt)
      });
    }
  }
}

// Region matrix tables: those with a deployment-type heading
const regionMatrix = {}; // lowercased slug -> Set of region display names
const regionTables = tables.filter((t) => deploymentTypeForTable(t));
for (const t of regionTables) {
  const header = t.rows[0];
  if (header.length < 3) continue;
  const regionCodes = header.slice(2);
  for (let i = 1; i < t.rows.length; i++) {
    const row = t.rows[i];
    if (row.length < 3) continue;
    const slug = row[0].toLowerCase();
    for (let j = 0; j < regionCodes.length; j++) {
      if (isAvailable(row[2 + j])) {
        const name = REGION_CODE_TO_NAME[regionCodes[j]];
        if (name) {
          if (!regionMatrix[slug]) regionMatrix[slug] = new Set();
          regionMatrix[slug].add(name);
        }
      }
    }
  }
}

// Group records by (provider, deployment_type, display_name)
const groups = new Map();
for (const r of records) {
  const key = `${r.provider}|${r.deployment_type}|${r.display_name}`;
  if (!groups.has(key)) {
    groups.set(key, {
      provider: r.provider,
      deployment_type: r.deployment_type,
      models: [r.display_name],
      offer_availability_region: r.offer_region,
      slugs: new Set(),
      versions: new Set()
    });
  }
  const g = groups.get(key);
  g.slugs.add(r.model_slug);
  if (r.version) g.versions.add(r.version);
}

const output = [];
for (const g of groups.values()) {
  const slug = [...g.slugs][0];
  const regions = regionMatrix[slug.toLowerCase()] ? [...regionMatrix[slug.toLowerCase()]].sort() : [];
  const entry = {
    provider: g.provider,
    deployment_type: g.deployment_type,
    models: g.models,
    offer_availability_region: g.offer_availability_region,
    hub_project_region_deployment: regions
  };
  if (regions.length === 0) {
    entry.note = 'No region matrix data available on this page for this model/deployment type.';
  }
  output.push(entry);
}

fs.writeFileSync('/workspace/azure-model-others-ava.json', JSON.stringify(output, null, 2));
console.log('entries:', output.length, 'models:', output.reduce((a, e) => a + e.models.length, 0));

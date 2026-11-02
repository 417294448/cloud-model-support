const fs = require('fs');
const ENDPOINTS_HTML = '/tmp/aws-endpoints.html';
const ENDPOINTS_SOURCE = 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html';

const NAME_NORMALIZE = {
  'Anthropic|Claude 3.5 Sonnet v2': 'Claude 3.5 Sonnet V2:0'
};

function cellText(c) {
  c = c.replace(/<img[^>]*icon-yes[^>]*>/gi, 'YES').replace(/<img[^>]*icon-no[^>]*>/gi, 'NO');
  return c
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTables(html) {
  const headings = [];
  const headingRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/g;
  let hm;
  while ((hm = headingRe.exec(html))) {
    headings.push({ pos: hm.index, text: cellText(hm[1]) });
  }
  function nearestHeading(pos) {
    let nearest = null;
    for (const h of headings) {
      if (h.pos < pos) nearest = h;
      else break;
    }
    return nearest ? nearest.text : null;
  }

  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = tableRe.exec(html))) {
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1]))
    );
    tables.push({ index: tables.length, headingBefore: nearestHeading(m.index), rows });
  }
  return tables;
}

function boolFromCell(cell) {
  const u = cell.toUpperCase().trim();
  if (u === 'YES' || u === 'TRUE' || u === 'Y') return true;
  if (u === 'NO' || u === 'FALSE' || u === 'N' || u === '-' || u === '' || u === '—') return false;
  return false;
}

function parseEndpoints() {
  const html = fs.readFileSync(ENDPOINTS_HTML, 'utf8');
  const tables = extractTables(html);
  const providers = [];
  const issues = [];

  for (const t of tables) {
    if (!t.headingBefore) continue;
    const header = t.rows[0];
    const idx = {};
    header.forEach((h, i) => {
      const u = h.toUpperCase();
      if (u.includes('MODEL NAME')) idx.name = i;
      if (u.includes('BEDROCK-RUNTIME')) idx.rt = i;
      if (u.includes('BEDROCK-MANTLE')) idx.mt = i;
    });
    if (idx.name === undefined) continue;
    const models = [];
    for (let i = 1; i < t.rows.length; i++) {
      const row = t.rows[i];
      if (row.length < 2) continue;
      let modelName = row[idx.name] || '';
      const normKey = t.headingBefore + '|' + modelName;
      if (NAME_NORMALIZE[normKey]) modelName = NAME_NORMALIZE[normKey];
      models.push({
        model_name: modelName,
        bedrock_runtime: boolFromCell(row[idx.rt] || ''),
        bedrock_mantle: boolFromCell(row[idx.mt] || ''),
        card_url: null
      });
    }
    providers.push({ provider: t.headingBefore, models });
  }

  return { source: ENDPOINTS_SOURCE, providers, issues };
}

function buildPatch(endpoints) {
  const updates = [];
  for (const p of endpoints.providers) {
    for (const m of p.models) {
      updates.push({
        match: { g: p.provider, n: m.model_name },
        set: { api: { rt: m.bedrock_runtime, mt: m.bedrock_mantle } }
      });
    }
  }
  return { matchKeys: ['g', 'n'], updates };
}

const result = parseEndpoints();
const { issues, ...endpoints } = result;
fs.writeFileSync('/workspace/aws-model-runtime&mantle.json', JSON.stringify(endpoints, null, 2));
const patch = buildPatch(endpoints);
fs.writeFileSync('/tmp/aws-api-patch.json', JSON.stringify(patch, null, 2));
console.log('providers:', endpoints.providers.length);
console.log('patch entries:', patch.updates.length);
if (issues.length) console.log('issues:\n' + issues.join('\n'));

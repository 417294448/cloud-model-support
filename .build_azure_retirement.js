const fs = require('fs');
const HTML = '/tmp/azure-retirement.html';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule';

function cellText(c) {
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

function parseDate(raw) {
  if (!raw || raw.trim() === '-' || raw.trim() === '—' || raw.trim() === '') return null;
  const text = raw.trim();
  const m1 = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m1) {
    const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const mon = monthNames.indexOf(m1[1].toLowerCase());
    if (mon >= 0) {
      return `${m1[3]}-${String(mon + 1).padStart(2, '0')}-${String(parseInt(m1[2], 10)).padStart(2, '0')}`;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

function parseReplacement(raw) {
  if (!raw || raw.trim() === '-' || raw.trim() === '—' || raw.trim() === '') return null;
  return raw.trim();
}

function parseLifecycle(raw) {
  const u = raw.trim().toUpperCase();
  if (u === 'GA') return 'GA';
  if (u === 'LEGACY') return 'Legacy';
  if (u === 'DEPRECATED') return 'Deprecated';
  if (u === 'RETIRED') return 'Retired';
  if (u === 'PREVIEW') return 'Preview';
  return raw.trim();
}

const html = fs.readFileSync(HTML, 'utf8');
const tables = extractTables(html);
const sections = [];

for (const t of tables) {
  if (!t.headingBefore) continue;
  // Skip non-provider headings
  const skip = ['In this article', 'Foundry Models sold by Azure', 'Foundry Models from partners and community', 'Fine-tuned models', 'Related content', 'Feedback', 'Additional resources'];
  if (skip.includes(t.headingBefore)) continue;

  const header = t.rows[0];
  const idx = {};
  header.forEach((h, i) => {
    const u = h.toUpperCase();
    if (u.includes('MODEL')) idx.model = i;
    if (u.includes('VERSION')) idx.version = i;
    if (u.includes('LIFECYCLE')) idx.lifecycle = i;
    if (u.includes('RETIREMENT DATE')) idx.retirement = i;
    if (u.includes('REPLACEMENT')) idx.replacement = i;
  });
  if (idx.model === undefined) continue;

  const models = [];
  for (let i = 1; i < t.rows.length; i++) {
    const row = t.rows[i];
    if (row.length < 2) continue;
    const model = {
      model: row[idx.model] || '',
      version: row[idx.version] || '',
      lifecycle: idx.lifecycle !== undefined ? parseLifecycle(row[idx.lifecycle] || '') : 'GA',
      retirement_date: idx.retirement !== undefined ? parseDate(row[idx.retirement] || '') : null,
      replacement: idx.replacement !== undefined ? parseReplacement(row[idx.replacement] || '') : null
    };
    models.push(model);
  }

  if (models.length) {
    sections.push({
      category: t.headingBefore,
      provider: t.headingBefore,
      models
    });
  }
}

const output = { source: SOURCE, sections };
fs.writeFileSync('/workspace/azure-model-retirement.json', JSON.stringify(output, null, 2));
console.log('sections:', sections.length, 'models:', sections.reduce((a, s) => a + s.models.length, 0));

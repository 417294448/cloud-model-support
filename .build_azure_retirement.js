const fs = require('fs');
const HTML = '/tmp/azure-retirement.html';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule';

function cellText(c) {
  c = c.replace(/<img[^>]*icon-yes[^>]*>/gi, 'YES').replace(/<img[^>]*icon-no[^>]*>/gi, 'NO');
  return c
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8203;/g, '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTables(html) {
  const headings = [];
  const headingRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/g;
  let hm;
  while ((hm = headingRe.exec(html))) headings.push({ pos: hm.index, text: cellText(hm[1]) });
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

function blank(v) {
  return v === undefined || v === null || v === '' || v === '-' || v === '—' || v === '–';
}

function dateOrNull(v) {
  if (blank(v)) return null;
  const m = v.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : v;
}

// The "Fine-tuned models" table uses Training/Deployment columns instead of
// Lifecycle/Retirement date/Replacement -- it has no lifecycle column, so it
// is skipped (same as the file's existing shape).
function parse() {
  const tables = extractTables(fs.readFileSync(HTML, 'utf8'));
  const sections = [];
  const issues = [];

  for (const t of tables) {
    const header = t.rows[0] || [];
    const idx = {};
    header.forEach((h, i) => {
      const u = h.toUpperCase();
      if (u === 'MODEL') idx.model = i;
      if (u === 'VERSION') idx.version = i;
      if (u === 'LIFECYCLE') idx.lifecycle = i;
      if (u === 'RETIREMENT DATE') idx.retirement_date = i;
      if (u === 'REPLACEMENT') idx.replacement = i;
    });
    if (idx.lifecycle === undefined || idx.retirement_date === undefined) {
      issues.push(`skipped table ${t.index} (${t.headingBefore}): no Lifecycle/Retirement date columns`);
      continue;
    }
    const category = t.headingBefore || 'UNKNOWN';
    const models = [];
    for (let i = 1; i < t.rows.length; i++) {
      const row = t.rows[i];
      let model = row[idx.model] || '';
      if (!model) {
        if (models.length) {
          model = models[models.length - 1].model;
          issues.push(`table ${t.index} row ${i}: empty Model cell, reused "${model}"`);
        } else {
          issues.push(`table ${t.index} row ${i}: empty Model cell with no predecessor, skipped`);
          continue;
        }
      }
      const replacement = row[idx.replacement];
      models.push({
        model,
        version: idx.version === undefined ? null : (blank(row[idx.version]) ? null : row[idx.version]),
        lifecycle: blank(row[idx.lifecycle]) ? null : row[idx.lifecycle],
        retirement_date: dateOrNull(row[idx.retirement_date]),
        replacement: blank(replacement) ? null : replacement
      });
    }
    sections.push({ category, provider: category, models });
  }
  return { source: SOURCE, sections, issues };
}

const { source, sections, issues } = parse();
fs.writeFileSync('azure-model-retirement.json', JSON.stringify({ source, sections }, null, 2));
console.log('sections:', sections.length, 'models:', sections.reduce((a, s) => a + s.models.length, 0));
if (issues.length) console.log('issues:\n' + issues.join('\n'));

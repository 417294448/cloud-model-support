#!/usr/bin/env node
// Rebuild azure-model-retirement.json from the freshly fetched
// model-retirement-schedule page. Every data table on that page (except the
// "Fine-tuned models" one, whose columns are training/deployment retirement
// dates, not lifecycle) has the same 5-column shape:
//   Model | Version | Lifecycle | Retirement date | Replacement
// and each table's nearest heading is the section category/provider.
const fs = require('fs');

const HTML = '/tmp/azure-retirement.html';
const OUT = '/workspace/azure-model-retirement.json';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule';

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
  while ((hm = headingRe.exec(html))) headings.push({ pos: hm.index, text: cellText(hm[1]) });
  function nearestHeading(pos) {
    let nearest = null;
    for (const h of headings) { if (h.pos < pos) nearest = h; else break; }
    return nearest ? nearest.text : null;
  }

  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = tableRe.exec(html))) {
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1]))
    );
    tables.push({ headingBefore: nearestHeading(m.index), rows });
  }
  return tables;
}

function parseIso(raw) {
  const text = (raw || '').trim();
  if (!text || text === '-' || text === '—') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m) {
    const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const mon = months.indexOf(m[1].toLowerCase());
    if (mon >= 0) return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
  }
  return text; // keep the raw note text rather than dropping it
}

function nullIfEmpty(raw) {
  const text = (raw || '').trim();
  return !text || text === '-' || text === '—' ? null : text;
}

const EXPECTED_HEADER = ['model', 'version', 'lifecycle', 'retirement date', 'replacement'];
const tables = extractTables(fs.readFileSync(HTML, 'utf8'));
const sections = [];
for (const t of tables) {
  const header = (t.rows[0] || []).map((h) => h.toLowerCase());
  if (header.length !== EXPECTED_HEADER.length || !header.every((h, i) => h === EXPECTED_HEADER[i])) continue;
  const models = [];
  for (let i = 1; i < t.rows.length; i++) {
    const row = t.rows[i];
    if (row.length < 5) continue;
    models.push({
      model: nullIfEmpty(row[0]),
      version: nullIfEmpty(row[1]),
      lifecycle: nullIfEmpty(row[2]),
      retirement_date: parseIso(row[3]),
      replacement: nullIfEmpty(row[4]),
    });
  }
  sections.push({ category: t.headingBefore, provider: t.headingBefore, models });
}

const before = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const out = { source: SOURCE, sections };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

// Summary: what actually changed vs the previous JSON
const flat = (r) => {
  const map = new Map();
  for (const s of r.sections) for (const m of s.models) map.set(`${s.category}|${m.model}|${m.version || ''}`, m);
  return map;
};
if (before) {
  const a = flat(before), b = flat(out);
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)));
  console.log(`sections: ${before.sections.length} -> ${out.sections.length}`);
  console.log(`entries: ${a.size} -> ${b.size}`);
  console.log(`added (${added.length}): ${added.join(', ') || '(none)'}`);
  console.log(`removed (${removed.length}): ${removed.join(', ') || '(none)'}`);
  console.log(`changed (${changed.length}):`);
  for (const k of changed) console.log(`  ${k}\n    old ${JSON.stringify(a.get(k))}\n    new ${JSON.stringify(b.get(k))}`);
}

#!/usr/bin/env node
// Scratch parser: rebuild vertex-model-retirement.json from the fetched
// model-versions doc page, and emit the lifecycle patch in the exact shape
// apply_update.js expects (mirrors update-gcp.js's heuristic).
const fs = require('fs');

const HTML = '/tmp/gcp-versions.html';
const OUT = '/workspace/vertex-model-retirement.json';
const PATCH = '/tmp/gcp-retirement-patch.json';
const SOURCE = 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions';

function cellText(c) {
  return c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function extractTables(html) {
  const headings = [];
  for (const m of html.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/g)) headings.push({ pos: m.index, text: cellText(m[1]) });
  const nearest = (pos) => { let n = null; for (const h of headings) { if (h.pos < pos) n = h; else break; } return n ? n.text : null; };
  const tables = [];
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1])));
    tables.push({ headingBefore: nearest(m.index), rows });
  }
  return tables;
}
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function parseFullDate(raw) {
  const t = (raw || '').trim();
  const m = t.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
}
function parseMonthYear(raw) {
  const t = (raw || '').trim();
  const m = t.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  return `${m[2]}-${String(mon + 1).padStart(2, '0')}`;
}

const SECTION_MAP = [
  [/^Gemini models$/i, 'Gemini models'],
  [/^Gemini image models$/i, 'Gemini image models'],
  [/^Veo models$/i, 'Veo models'],
  [/^Embeddings models$/i, 'Embeddings models'],
  [/^Models available for shorter availability periods$/i, 'Models available for shorter availability periods'],
  [/retired models/i, 'Retired models'],
];
function sectionName(h) {
  for (const [re, name] of SECTION_MAP) if (h && re.test(h)) return name;
  return null;
}

const tables = extractTables(fs.readFileSync(HTML, 'utf8'));
const sections = [];
const issues = [];
for (const t of tables) {
  const header = (t.rows[0] || []).map((h) => h.toLowerCase());
  if (header.length !== 4 || header[0] !== 'model id') continue;
  const name = sectionName(t.headingBefore);
  if (!name) { issues.push('unmapped table heading: ' + t.headingBefore); continue; }
  const models = [];
  for (let i = 1; i < t.rows.length; i++) {
    const row = t.rows[i];
    if (row.length < 4 || !row[0]) continue;
    const model = row[0].replace(/\s*\*\s*$/, '').trim();
    const relRaw = row[1] || '';
    const retRaw = row[2] || '';
    const repRaw = row[3] || '';
    const relFull = parseFullDate(relRaw);
    const relYM = relFull ? null : parseMonthYear(relRaw);
    const retFull = parseFullDate(retRaw);
    models.push({
      model,
      release_date: relFull || relYM || null,
      release_date_note: relFull || relYM ? null : (relRaw || null),
      retirement_date: retFull || null,
      retirement_date_note: retFull ? null : (retRaw || null),
      replacement: repRaw ? repRaw : null,
    });
  }
  sections.push({ category: name, models });
}

const out = { source: SOURCE, sections };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('sections:', sections.map((s) => s.category + '(' + s.models.length + ')').join(', '));
if (issues.length) console.log('issues:\n' + issues.join('\n'));

// ---- lifecycle patch (mirrors update-gcp.js heuristic) ----
const RETIRED_BUT_TAGGED = {
  'textembedding-gecko': { lifecycle: 'Deprecated', retirementDate: '2025-05-24', replacement: 'gemini-embedding-001' },
};
const lookup = new Map();
for (const sec of out.sections) {
  const retired = sec.category === 'Retired models';
  for (const m of sec.models) {
    const base = m.model.split('@')[0];
    if (retired && !RETIRED_BUT_TAGGED[base]) continue;
    const retirementDate = m.retirement_date || m.retirement_date_note || null;
    const replacement = m.replacement || null;
    const isExact = /^\d{4}-\d{2}-\d{2}$/.test(m.retirement_date || '');
    const lifecycle = (isExact && replacement) ? 'Deprecated' : 'Legacy';
    lookup.set(base, { lifecycle, retirementDate, replacement });
  }
}
for (const [k, v] of Object.entries(RETIRED_BUT_TAGGED)) lookup.set(k, v);
const patch = { matchKeys: ['n'], updates: [...lookup.entries()].map(([n, set]) => ({ match: { n }, set })) };
fs.writeFileSync(PATCH, JSON.stringify(patch, null, 2) + '\n');
console.log('patch entries:', patch.updates.length, '->', PATCH);

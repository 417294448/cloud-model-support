// Re-scrape vertex-model-retirement.json from the Gemini/Vertex model-versions page.
const fs = require('fs');

const HTML = '/tmp/gcp-versions.html';
const SOURCE = 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions';

function cellText(c) {
  return c
    .replace(/<code[^>]*>/gi, '').replace(/<\/code>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function parseDate(raw) {
  if (!raw) return null;
  const m = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi < 0) return null;
    return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
  }
  const my = raw.match(/^([A-Za-z]+)\s+(\d{4})$/); // month-only, e.g. "May 2023"
  if (my) {
    const mi = MONTHS.indexOf(my[1].toLowerCase());
    if (mi < 0) return null;
    return `${my[2]}-${String(mi + 1).padStart(2, '0')}`;
  }
  return null;
}

const html = fs.readFileSync(HTML, 'utf8');
const marks = [];
for (const m of html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)) marks.push({ pos: m.index, type: 'h', text: cellText(m[1]) });
for (const m of html.matchAll(/<table[\s\S]*?<\/table>/g)) marks.push({ pos: m.index, type: 'table', html: m[0] });
marks.sort((a, b) => a.pos - b.pos);

let heading = null;
const sections = [];
const seen = new Set();
for (const mark of marks) {
  if (mark.type === 'h') { heading = mark.text.trim(); continue; }
  if (!heading || /^Products|^Support|^Resources|^Engage/.test(heading)) continue;
  const rows = [...mark.html.matchAll(/<tr[\s\S]*?<\/tr>/g)]
    .map((r) => [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1])));
  if (!rows.length || !/^model id$/i.test(rows[0][0] || '')) continue;
  const models = [];
  for (const row of rows.slice(1)) {
    if (!row[0]) continue;
    const releaseRaw = row[1] || '';
    const retirementRaw = row[2] || '';
    const replRaw = row[3] || '';
    models.push({
      model: row[0].replace(/\s*\*+$/, '').trim(), // strip footnote asterisks
      release_date: parseDate(releaseRaw),
      release_date_note: parseDate(releaseRaw) ? null : (releaseRaw || null),
      retirement_date: parseDate(retirementRaw),
      retirement_date_note: parseDate(retirementRaw) ? null : (retirementRaw || null),
      replacement: replRaw || null,
    });
  }
  if (!models.length) continue;
  let title = heading;
  let n = 2;
  while (seen.has(title)) title = heading + ' (' + n++ + ')';
  seen.add(title);
  sections.push({ category: title, models });
}

const out = { source: SOURCE, sections };
fs.writeFileSync('vertex-model-retirement-new.json', JSON.stringify(out, null, 2));
sections.forEach((s) => console.log(s.category, '->', s.models.length));
console.log('sections', sections.length, 'models', sections.reduce((a, s) => a + s.models.length, 0));

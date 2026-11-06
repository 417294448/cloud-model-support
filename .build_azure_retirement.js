// Re-scrape azure-model-retirement.json from the Foundry model retirement schedule page.
// One section per <h3>/<h4> heading, each table: Model | Version | Lifecycle | Retirement date | Replacement.
const fs = require('fs');

const HTML = '/tmp/azure-retirement.html';
const OUT = 'azure-model-retirement.json';
const SOURCE = 'https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule';

function cellText(c) {
  return c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
const stripFn = (s) => s.replace(/\s+\d+$/, '').trim(); // drop footnote markers like "2027-04-14 3"
const stripRefs = (s) => s.replace(/\s+\d+(?=\s*(?:[,;]|$))/g, '').replace(/\s+,/g, ',').trim(); // "x-fp8 1 , y" -> "x-fp8, y"
const emptyToNull = (s) => (!s || s === '—' || s === '-' ? null : s);

const html = fs.readFileSync(HTML, 'utf8');
const marks = [];
for (const m of html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)) marks.push({ pos: m.index, type: 'h', text: cellText(m[1]) });
for (const m of html.matchAll(/<table[\s\S]*?<\/table>/g)) marks.push({ pos: m.index, type: 'table', html: m[0] });
marks.sort((a, b) => a.pos - b.pos);

let heading = null;
const sections = [];
for (const mark of marks) {
  if (mark.type === 'h') { heading = mark.text; continue; }
  const rows = [...mark.html.matchAll(/<tr[\s\S]*?<\/tr>/g)]
    .map((r) => [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1])));
  const header = rows[0].map((h) => h.toLowerCase());
  // Skip the "Fine-tuned models" table and anything else that isn't the 5-column schedule.
  if (!(header[0] === 'model' && header[2] === 'lifecycle' && header[3] === 'retirement date')) continue;
  const models = [];
  for (const row of rows.slice(1)) {
    if (!row[0]) continue;
    models.push({
      model: stripFn(row[0]),
      version: emptyToNull(stripFn(row[1] || '')),
      lifecycle: stripFn(row[2] || ''),
      retirement_date: emptyToNull(stripFn(row[3] || '')),
      replacement: emptyToNull(stripRefs(row[4] || '')),
    });
  }
  sections.push({ category: heading, provider: heading, models });
}

fs.writeFileSync('azure-model-retirement-new.json', JSON.stringify({ source: SOURCE, sections }, null, 2));
sections.forEach((s) => console.log(s.category, '->', s.models.length));
console.log('sections', sections.length, 'models', sections.reduce((a, s) => a + s.models.length, 0));

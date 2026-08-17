const fs = require('fs');
const REGION_HTML = '/tmp/aws-region.html';

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

  function captionOf(tableHtml) {
    const m = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    if (!m) return null;
    const linkMatch = m[1].match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (linkMatch) return { text: cellText(linkMatch[2]), href: linkMatch[1] };
    return { text: cellText(m[1]), href: null };
  }

  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = tableRe.exec(html))) {
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1]))
    );
    tables.push({ index: tables.length, headingBefore: nearestHeading(m.index), caption: captionOf(m[0]), rows });
  }
  return tables;
}

function parseRegionCode(raw) {
  const m = raw.match(/^([a-z]{2}-[a-z]+-\d+)/);
  return m ? m[1] : raw.trim();
}

function isAvailable(cell) {
  const u = cell.toUpperCase();
  if (u === 'YES') return true;
  if (u === 'NO') return false;
  if (/LEGACY\s*\(EOL:/i.test(cell)) return true;
  return false;
}

function parseRegionTables() {
  const html = fs.readFileSync(REGION_HTML, 'utf8');
  const tables = extractTables(html);
  const models = [];
  const seen = new Map();
  const issues = [];

  for (const t of tables) {
    if (!t.caption || !t.caption.text) continue;
    const g = t.headingBefore || 'UNKNOWN';
    const n = t.caption.text;
    const card = t.caption.href;
    const key = g + '|' + n;

    let model;
    if (seen.has(key)) {
      model = seen.get(key);
      issues.push(`duplicate caption union: ${g} / ${n} (table ${t.index})`);
    } else {
      model = { g, n, v: null, card, s: {} };
      seen.set(key, model);
      models.push(model);
    }

    const header = t.rows[0];
    const colIdx = {};
    header.forEach((h, i) => {
      const u = h.toUpperCase();
      if (u.includes('IN-REGION') || u === 'IN-REGION' || u === 'IN REGION') colIdx.in = i;
      if (u.includes('GEO')) colIdx.geo = i;
      if (u.includes('GLOBAL')) colIdx.global = i;
    });

    for (let i = 1; i < t.rows.length; i++) {
      const row = t.rows[i];
      if (row.length < 2) continue;
      const region = parseRegionCode(row[0]);
      let mask = 0;
      if (colIdx.in !== undefined && isAvailable(row[colIdx.in])) mask |= 1;
      if (colIdx.geo !== undefined && isAvailable(row[colIdx.geo])) mask |= 2;
      if (colIdx.global !== undefined && isAvailable(row[colIdx.global])) mask |= 4;
      if (mask) {
        model.s[region] = (model.s[region] || 0) | mask;
      }
    }
  }

  return { models, issues, tableCount: tables.length };
}

const { models, issues, tableCount } = parseRegionTables();
fs.writeFileSync('/tmp/aws-models.json', JSON.stringify(models, null, 2));
console.log('tables:', tableCount, 'models:', models.length);
if (issues.length) console.log('issues:\n' + issues.join('\n'));

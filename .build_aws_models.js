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
  // e.g. "us-east-1 (N. Virginia)" -> "us-east-1"; multi-segment codes like
  // "us-gov-west-1 (GovCloud)" must also normalize to the bare code.
  const m = raw.match(/^([a-z]{2}(?:-[a-z]+)+-\d+)/);
  return m ? m[1] : raw.trim();
}

function toAbsoluteRegionCard(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  if (href.startsWith('./')) {
    return 'https://docs.aws.amazon.com/bedrock/latest/userguide/' + href.slice(2);
  }
  if (href.startsWith('/')) {
    return 'https://docs.aws.amazon.com' + href;
  }
  return 'https://docs.aws.amazon.com/bedrock/latest/userguide/' + href;
}

function isAvailable(cell) {
  const u = cell.toUpperCase();
  if (u === 'YES') return true;
  if (u === 'NO') return false;
  // A retiring region is annotated with a date instead of a yes-icon and still
  // counts as available (README quirk #4). Two formats are live on the page:
  // the older "Legacy (EOL: YYYY-MM-DD)" and the newer bare "EOL: YYYY-MM-DD".
  if (/LEGACY\s*\(EOL:/i.test(cell)) return true;
  if (/\bEOL\s*:/i.test(cell)) return true;
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
    const card = toAbsoluteRegionCard(t.caption.href);
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
    // The page now splits In-Region into "In-Region (bedrock-mantle)" and
    // "In-Region (bedrock-runtime)" for models served over the newer Mantle
    // endpoint; older tables carry a single plain "In-Region" column. The `in`
    // bit means "request can be processed in-region", so it is set when either
    // in-region column reports availability.
    const inCols = [];
    let geoCol;
    let globalCol;
    header.forEach((h, i) => {
      const u = h.toUpperCase();
      if (u.includes('IN-REGION') || u === 'IN REGION') inCols.push(i);
      if (u.includes('GEO')) geoCol = i;
      if (u.includes('GLOBAL')) globalCol = i;
    });
    const cellAt = (row, i) => (i === undefined || i < 0 || i >= row.length ? '' : row[i]);

    for (let i = 1; i < t.rows.length; i++) {
      const row = t.rows[i];
      if (row.length < 2) continue;
      const region = parseRegionCode(row[0]);
      if (row.length < header.length) {
        issues.push(`short row (${row.length}/${header.length} cells) for ${g} / ${n} region ${region}`);
      }
      let mask = 0;
      if (inCols.some((c) => isAvailable(cellAt(row, c)))) mask |= 1;
      if (isAvailable(cellAt(row, geoCol))) mask |= 2;
      if (isAvailable(cellAt(row, globalCol))) mask |= 4;
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

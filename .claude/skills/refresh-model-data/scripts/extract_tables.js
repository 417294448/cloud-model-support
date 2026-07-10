#!/usr/bin/env node
/**
 * Pull every <table> out of a raw HTML doc dump and print it as plain-text
 * rows, tagged with the nearest preceding <h2>-<h4> heading so you can tell
 * which section/category each table belongs to.
 *
 * This is the exact extraction method proven against AWS Bedrock and GCP
 * Vertex/Gemini doc pages: strip tags to plain text per cell, keep row/table
 * boundaries. It does NOT try to guess column meaning or model schema -- that
 * mapping is source-specific and is still a judgment call for whoever (human
 * or agent) is turning this into the target JSON shape.
 *
 * Usage:
 *   node extract_tables.js <html-file>            # all tables
 *   node extract_tables.js <html-file> --index 2  # just table #2 (0-based)
 */
const fs = require('fs');

const [, , htmlFile, flag, idxArg] = process.argv;
if (!htmlFile) {
  console.error('usage: extract_tables.js <html-file> [--index N]');
  process.exit(1);
}

const html = fs.readFileSync(htmlFile, 'utf8');

function cellText(c) {
  // Some vendor tables (AWS Bedrock's region-compatibility page, notably)
  // encode yes/no as <img src=".../icon-yes.png"> / icon-no.png instead of
  // text -- plain tag-stripping would silently turn both into "". Catch that
  // pattern before stripping tags so availability cells don't come out blank.
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

function captionOf(tableHtml) {
  // Some tables carry their subject (e.g. a model name) in a <caption>
  // instead of a heading before the table -- one heading can precede many
  // per-model tables (AWS: one <h2> per provider, one <table> per model).
  const m = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
  if (!m) return null;
  const linkMatch = m[1].match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
  if (linkMatch) return { text: cellText(linkMatch[2]), href: linkMatch[1] };
  return { text: cellText(m[1]), href: null };
}

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
  tables.push({ index: tables.length, headingBefore: nearestHeading(m.index), caption: captionOf(m[0]), rows });
}

if (flag === '--index') {
  const idx = Number(idxArg);
  if (!tables[idx]) {
    console.error(`table index ${idx} out of range (found ${tables.length} tables)`);
    process.exit(1);
  }
  console.log(JSON.stringify(tables[idx], null, 2));
} else {
  console.log(
    JSON.stringify(
      tables.map((t) => ({ index: t.index, headingBefore: t.headingBefore, caption: t.caption && t.caption.text, rowCount: t.rows.length, header: t.rows[0] })),
      null,
      2
    )
  );
  console.error(`\n${tables.length} tables found. Re-run with --index N to dump one table's full rows.`);
}

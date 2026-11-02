#!/usr/bin/env node
const fs = require('fs');

const REGION_HTML = '/tmp/aws-region.html';
const LIFECYCLE_HTML = '/tmp/aws-lifecycle.html';
const ENDPOINTS_HTML = '/tmp/aws-endpoints.html';

const REGION_SOURCE = 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html';
const LIFECYCLE_SOURCE = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html';
const ENDPOINTS_SOURCE = 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html';

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

function parseRegionCode(raw) {
  // e.g. "us-east-1 (N. Virginia)" -> "us-east-1"
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
  const seen = new Map(); // key: g|n -> model

  for (const t of tables) {
    if (!t.caption || !t.caption.text) continue; // skip non-model tables
    const g = t.headingBefore || 'UNKNOWN';
    const n = t.caption.text;
    const card = toAbsoluteRegionCard(t.caption.href);
    const key = g + '|' + n;

    let model;
    if (seen.has(key)) {
      model = seen.get(key);
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
    const regionCol = 0;

    for (let i = 1; i < t.rows.length; i++) {
      const row = t.rows[i];
      if (row.length < 2) continue;
      const region = parseRegionCode(row[regionCol]);
      let mask = 0;
      if (colIdx.in !== undefined && isAvailable(row[colIdx.in])) mask |= 1;
      if (colIdx.geo !== undefined && isAvailable(row[colIdx.geo])) mask |= 2;
      if (colIdx.global !== undefined && isAvailable(row[colIdx.global])) mask |= 4;
      if (mask) {
        // union with existing mask if any
        model.s[region] = (model.s[region] || 0) | mask;
      }
    }
  }

  return models;
}

function parseDate(raw) {
  if (!raw || raw.trim() === '-' || raw.trim() === '') return null;
  const text = raw.trim();
  // Try Month DD, YYYY
  const m1 = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m1) {
    const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const mon = monthNames.indexOf(m1[1].toLowerCase());
    if (mon >= 0) {
      return `${m1[3]}-${String(mon + 1).padStart(2, '0')}-${String(parseInt(m1[2], 10)).padStart(2, '0')}`;
    }
  }
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

function parseLifecycle() {
  const html = fs.readFileSync(LIFECYCLE_HTML, 'utf8');
  const tables = extractTables(html);
  const models = [];
  for (const t of tables) {
    const header = t.rows[0];
    const idx = {};
    header.forEach((h, i) => {
      const u = h.toUpperCase();
      if (u.includes('MODEL PROVIDER')) idx.provider = i;
      if (u.includes('MODEL NAME')) idx.model_name = i;
      if (u.includes('MODEL ID')) idx.model_id = i;
      if (u.includes('REGIONS')) idx.regions = i;
      if (u.includes('LEGACY DATE')) idx.legacy_date = i;
      if (u.includes('EOL DATE')) idx.eol_date = i;
      if (u.includes('PUBLIC EXTENDED ACCESS')) idx.public_extended_access_start_date = i;
    });
    for (let i = 1; i < t.rows.length; i++) {
      const row = t.rows[i];
      if (row.length < 4) continue;
      const regionsRaw = row[idx.regions] || '';
      const regions = regionsRaw.split(/,\s*/).map(r => r.trim()).filter(Boolean);
      const legacyRaw = row[idx.legacy_date] || '';
      const eolRaw = row[idx.eol_date] || '';
      const peaRaw = row[idx.public_extended_access_start_date] || '';
      const legacyDate = parseDate(legacyRaw);
      const eolDate = parseDate(eolRaw);
      const peaDate = parseDate(peaRaw);
      const entry = {
        provider: row[idx.provider] || '',
        model_name: row[idx.model_name] || '',
        model_id: row[idx.model_id] || '',
        region_groups: [{
          regions,
          legacy_date: legacyDate || legacyRaw,
          eol_date: eolDate || eolRaw,
          public_extended_access_start_date: peaDate || peaRaw
        }]
      };
      models.push(entry);
    }
  }
  return { source: LIFECYCLE_SOURCE, models };
}

function boolFromCell(cell) {
  const u = cell.toUpperCase().trim();
  if (u === 'YES' || u === 'TRUE' || u === 'Y') return true;
  if (u === 'NO' || u === 'FALSE' || u === 'N' || u === '-' || u === '') return false;
  return false;
}

function parseEndpoints() {
  const html = fs.readFileSync(ENDPOINTS_HTML, 'utf8');
  const tables = extractTables(html);
  const providers = [];
  for (const t of tables) {
    if (!t.headingBefore) continue; // skip overview table
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
      models.push({
        model_name: row[idx.name] || '',
        bedrock_runtime: boolFromCell(row[idx.rt] || ''),
        bedrock_mantle: boolFromCell(row[idx.mt] || ''),
        card_url: null
      });
    }
    providers.push({ provider: t.headingBefore, models });
  }
  return { source: ENDPOINTS_SOURCE, providers };
}

const awsModels = parseRegionTables();
const awsRetirement = parseLifecycle();
const awsRuntime = parseEndpoints();

fs.writeFileSync('/workspace/aws-models.json', JSON.stringify(awsModels, null, 2));
fs.writeFileSync('/workspace/aws-model-retirement.json', JSON.stringify(awsRetirement, null, 2));
fs.writeFileSync('/workspace/aws-model-runtime&mantle.json', JSON.stringify(awsRuntime, null, 2));

console.log('aws-models.json:', awsModels.length, 'models');
console.log('aws-model-retirement.json:', awsRetirement.models.length, 'entries');
console.log('aws-model-runtime&mantle.json:', awsRuntime.providers.length, 'providers');

const fs = require('fs');
const LIFECYCLE_HTML = '/tmp/aws-lifecycle.html';
const LIFECYCLE_SOURCE = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html';

const NAME_NORMALIZE = {
  'Anthropic|Claude 3.5 Sonnet v2': 'Claude 3.5 Sonnet V2:0'
};

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
  if (!raw || raw.trim() === '-' || raw.trim() === '' || raw.trim() === '—') return null;
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

function makeDateField(raw) {
  const iso = parseDate(raw);
  if (iso) return { exact: iso };
  const text = raw && raw.trim() !== '-' && raw.trim() !== '' && raw.trim() !== '—' ? raw.trim() : null;
  return text ? { note: text } : null;
}

function parseLifecycle() {
  const html = fs.readFileSync(LIFECYCLE_HTML, 'utf8');
  const tables = extractTables(html);
  const entries = [];
  let current = null;
  const issues = [];

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
      if (row.length >= 7 && idx.provider !== undefined && row[idx.provider]) {
        let provider = row[idx.provider];
        let modelName = row[idx.model_name];
        const normKey = provider + '|' + modelName;
        if (NAME_NORMALIZE[normKey]) modelName = NAME_NORMALIZE[normKey];
        current = {
          provider,
          model_name: modelName,
          model_id: row[idx.model_id],
          region_groups: []
        };
        entries.push(current);
      } else if (current && row.length >= 4) {
        issues.push(`continuation row for ${current.provider} / ${current.model_name}: ${row[0]}`);
      } else {
        issues.push(`skipped row ${i}: ${JSON.stringify(row)}`);
        continue;
      }

      let regionsRaw, legacyRaw, eolRaw, peaRaw;
      if (row.length >= 7) {
        regionsRaw = row[idx.regions] || '';
        legacyRaw = row[idx.legacy_date] || '';
        eolRaw = row[idx.eol_date] || '';
        peaRaw = row[idx.public_extended_access_start_date] || '';
      } else {
        regionsRaw = row[0] || '';
        legacyRaw = row[1] || '';
        eolRaw = row[2] || '';
        peaRaw = row[3] || '';
      }

      const regions = regionsRaw.split(/,\s*/).map(r => r.trim()).filter(Boolean);
      const legacy = makeDateField(legacyRaw);
      const eol = makeDateField(eolRaw);
      const pea = makeDateField(peaRaw);

      const group = { regions };
      if (legacy) {
        if (legacy.exact) group.legacy_date = legacy.exact;
        else group.legacy_date_note = legacy.note;
      } else {
        group.legacy_date = null;
      }
      if (eol) {
        if (eol.exact) group.eol_date = eol.exact;
        else group.eol_date_note = eol.note;
      } else {
        group.eol_date = null;
      }
      if (pea) {
        if (pea.exact) group.public_extended_access_start_date = pea.exact;
        else group.public_extended_access_start_date_note = pea.note;
      } else {
        group.public_extended_access_start_date = null;
      }

      current.region_groups.push(group);
    }
  }

  return { source: LIFECYCLE_SOURCE, models: entries, issues };
}

function buildPatch(retirement) {
  const updates = [];
  for (const m of retirement.models) {
    const eolGroup = m.region_groups.find(g => g.eol_date || g.eol_date_note);
    const legacyGroup = m.region_groups.find(g => g.legacy_date || g.legacy_date_note);
    let lifecycle;
    let retirementDate;
    if (eolGroup) {
      lifecycle = 'EOL';
      retirementDate = eolGroup.eol_date || eolGroup.eol_date_note;
    } else if (legacyGroup) {
      lifecycle = 'Legacy';
      retirementDate = legacyGroup.legacy_date || legacyGroup.legacy_date_note;
    } else {
      continue;
    }
    updates.push({
      match: { g: m.provider, n: m.model_name },
      set: { lifecycle, retirementDate }
    });
  }
  return { matchKeys: ['g', 'n'], updates };
}

const result = parseLifecycle();
const { issues, ...retirement } = result;
fs.writeFileSync('/workspace/aws-model-retirement.json', JSON.stringify(retirement, null, 2));
const patch = buildPatch(retirement);
fs.writeFileSync('/tmp/aws-retirement-patch.json', JSON.stringify(patch, null, 2));
console.log('models:', retirement.models.length);
console.log('patch entries:', patch.updates.length);
if (issues.length) console.log('issues:\n' + issues.join('\n'));

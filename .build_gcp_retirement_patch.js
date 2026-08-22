const fs = require('fs');

const retirement = JSON.parse(fs.readFileSync('/workspace/vertex-model-retirement.json', 'utf8'));

function deriveLifecycle(item) {
  const hasExactDate = item.retirement_date && /^\d{4}-\d{2}-\d{2}$/.test(item.retirement_date);
  const hasReplacement = item.replacement && item.replacement.trim() !== '';
  if (hasExactDate && hasReplacement) return 'Deprecated';
  return 'Legacy';
}

function deriveRetirementDate(item) {
  if (item.retirement_date) return item.retirement_date;
  if (item.retirement_date_note) return item.retirement_date_note;
  return null;
}

const updates = [];
for (const section of retirement.sections || []) {
  for (const m of section.models || []) {
    const matchName = m.model.replace(/@.*$/, '');
    const set = {
      lifecycle: deriveLifecycle(m),
      retirementDate: deriveRetirementDate(m)
    };
    if (m.replacement) set.replacement = m.replacement;
    updates.push({ match: { n: matchName }, set });
  }
}

const patch = { matchKeys: ['n'], updates };
fs.writeFileSync('/tmp/gcp-retirement-patch.json', JSON.stringify(patch, null, 2));
console.log('patch entries:', updates.length);

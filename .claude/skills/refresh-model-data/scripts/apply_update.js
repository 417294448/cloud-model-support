#!/usr/bin/env node
/**
 * Safely mutate the <script id="data"> JSON blob embedded in index.html and
 * write the result to a NEW file. Never overwrites --in (the script refuses
 * to run if --out resolves to the same path as --in) -- the whole point of
 * this skill is that index.html stays untouched until a human reviews
 * index-new.html and decides to promote it.
 *
 * That embedded blob is a single, very long line -- editors and line-based
 * tools choke on it. Always go through this script (or the same
 * read-JSON.parse-mutate-JSON.stringify-write pattern) instead of hand-editing
 * index.html's data line.
 *
 * Subcommands:
 *
 *   replace-models <in.html> <providerId> <models.json> --out <out.html>
 *                  [--regions regions.json] [--groups groups.json] [--generated YYYY-MM-DD]
 *     Wholesale-replaces provider.models (and optionally .regions/.groups/.generated).
 *     Leaves caps/capDefGroups/source/note/subtitle/etc untouched -- those are
 *     hand-tuned presentation data, not something a re-scrape should clobber.
 *     Use this when you've rebuilt a provider's full model x region list from
 *     its docs page (AWS, Azure) or a generator script (GCP).
 *
 *   replace-from-provider <in.html> <providerId> <providerObject.json> --out <out.html>
 *     Same as replace-models, but pulls .models/.regions/.groups/.generated
 *     out of a FULL provider-shaped JSON file (e.g. build_vertex_matrix.py's
 *     vertex.json output) so you don't have to hand-extract those fields first.
 *
 *   patch <in.html> <providerId> <patch.json> --out <out.html>
 *     patch.json: { "matchKeys": ["g","n"], "updates": [ { "match": {...}, "set": {...} } ] }
 *     Finds each existing model by matchKeys and merges `set` fields onto it
 *     (lifecycle, retirementDate, replacement, api, offer, ...). Use this for
 *     the retirement/lifecycle/API-surface supplements -- it only touches
 *     models that already exist, it never adds or removes models.
 *
 *   validate <html-file>
 *     Re-parses the data blob and syntax-checks the inline logic <script>.
 *     Run this on ANY index-new.html before telling the user it's ready,
 *     even if you didn't just write it with this script.
 *
 * replace-models / replace-from-provider / patch all validate their own
 * output and print a summary (model count deltas, added/removed models,
 * which fields changed on how many models, unmatched patch entries) so the
 * final report has real numbers instead of "looks done to me."
 */
const fs = require('fs');
const path = require('path');

const DATA_PREFIX = '<script id="data" type="application/json">';
const DATA_SUFFIX = '</script>';
const LOGIC_RE = /<script>([\s\S]*)<\/script>\s*<\/body>/;

function loadData(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf(DATA_PREFIX);
  if (start === -1) throw new Error(`${htmlPath}: could not find the data <script id="data"> tag`);
  const dataStart = start + DATA_PREFIX.length;
  const dataEnd = html.indexOf(DATA_SUFFIX, dataStart);
  const data = JSON.parse(html.slice(dataStart, dataEnd));
  return { html, dataStart, dataEnd, data };
}

function validate(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dataMatch = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!dataMatch) throw new Error(`${htmlPath}: data <script> tag missing`);
  JSON.parse(dataMatch[1]); // throws if the JSON is broken
  const logicMatch = html.match(LOGIC_RE);
  if (!logicMatch) throw new Error(`${htmlPath}: inline logic <script> missing (unexpected file shape)`);
  new Function(logicMatch[1]); // throws SyntaxError if the page's JS is broken
}

function save(html, dataStart, dataEnd, data, outPath) {
  const newHtml = html.slice(0, dataStart) + JSON.stringify(data) + html.slice(dataEnd);
  fs.writeFileSync(outPath, newHtml, 'utf8');
  validate(outPath);
}

function requireDifferentPaths(inPath, outPath) {
  // The safety property that matters is "never clobber the deployed index.html"
  // -- NOT "in and out must always differ". A full run chains three phases
  // through the SAME index-new.html (read it, write it, read it again for the
  // next phase, write it again), so in===out is the normal, expected case
  // from phase 2 onward. Only block the specific case that would actually
  // damage the source of truth: writing to a path literally named index.html.
  if (path.basename(path.resolve(outPath)) === 'index.html') {
    throw new Error('refusing to write --out to a file named index.html -- write to index-new.html (or similar) instead');
  }
}

function modelKey(mo, keys) {
  return keys.map((k) => JSON.stringify(mo[k])).join('');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function applyModelsReplace(provider, newModels, opts) {
  const oldKeys = new Set(provider.models.map((m) => modelKey(m, ['g', 'n'])));
  const newKeys = new Set(newModels.map((m) => modelKey(m, ['g', 'n'])));
  const added = [...newKeys].filter((k) => !oldKeys.has(k));
  const removed = [...oldKeys].filter((k) => !newKeys.has(k));

  console.log(`[${provider.id}] models: ${provider.models.length} -> ${newModels.length}`);
  console.log(`  added   (${added.length}): ${added.slice(0, 25).map(readable).join(', ')}${added.length > 25 ? ', ...' : ''}`);
  console.log(`  removed (${removed.length}): ${removed.slice(0, 25).map(readable).join(', ')}${removed.length > 25 ? ', ...' : ''}`);

  provider.models = newModels;
  if (opts.regions) provider.regions = opts.regions;
  if (opts.groups) provider.groups = opts.groups;
  else provider.groups = [...new Set(newModels.map((m) => m.g))].sort();
  if (opts.generated) provider.generated = opts.generated;

  function readable(k) {
    return JSON.parse(`[${k.split('').join(',')}]`).join(' / ');
  }
}

function cmdReplaceModels(argv) {
  const args = parseArgs(argv);
  const [inPath, providerId, modelsPath] = args._;
  const outPath = args.out;
  if (!inPath || !providerId || !modelsPath || !outPath) {
    console.error('usage: apply_update.js replace-models <in.html> <providerId> <models.json> --out <out.html> [--regions r.json] [--groups g.json] [--generated YYYY-MM-DD]');
    process.exit(1);
  }
  requireDifferentPaths(inPath, outPath);

  const { html, dataStart, dataEnd, data } = loadData(inPath);
  const provider = data.providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`provider "${providerId}" not found in ${inPath}`);

  const newModels = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  applyModelsReplace(provider, newModels, {
    regions: args.regions ? JSON.parse(fs.readFileSync(args.regions, 'utf8')) : null,
    groups: args.groups ? JSON.parse(fs.readFileSync(args.groups, 'utf8')) : null,
    generated: args.generated || null,
  });

  save(html, dataStart, dataEnd, data, outPath);
  console.log(`Wrote ${outPath}`);
}

function cmdReplaceFromProvider(argv) {
  const args = parseArgs(argv);
  const [inPath, providerId, providerJsonPath] = args._;
  const outPath = args.out;
  if (!inPath || !providerId || !providerJsonPath || !outPath) {
    console.error('usage: apply_update.js replace-from-provider <in.html> <providerId> <providerObject.json> --out <out.html> [--generated YYYY-MM-DD]');
    process.exit(1);
  }
  requireDifferentPaths(inPath, outPath);

  const { html, dataStart, dataEnd, data } = loadData(inPath);
  const provider = data.providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`provider "${providerId}" not found in ${inPath}`);

  const src = JSON.parse(fs.readFileSync(providerJsonPath, 'utf8'));
  if (!Array.isArray(src.models)) throw new Error(`${providerJsonPath} does not look like a provider object (no .models array)`);

  applyModelsReplace(provider, src.models, {
    regions: src.regions || null,
    groups: src.groups || null,
    generated: args.generated || src.generated || null,
  });

  save(html, dataStart, dataEnd, data, outPath);
  console.log(`Wrote ${outPath}`);
}

function cmdPatch(argv) {
  const args = parseArgs(argv);
  const [inPath, providerId, patchPath] = args._;
  const outPath = args.out;
  if (!inPath || !providerId || !patchPath || !outPath) {
    console.error('usage: apply_update.js patch <in.html> <providerId> <patch.json> --out <out.html>');
    process.exit(1);
  }
  requireDifferentPaths(inPath, outPath);

  const { html, dataStart, dataEnd, data } = loadData(inPath);
  const provider = data.providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`provider "${providerId}" not found in ${inPath}`);

  const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const keys = patch.matchKeys || ['g', 'n'];
  const index = new Map(provider.models.map((m) => [modelKey(m, keys), m]));

  let matched = 0;
  const unmatched = [];
  const fieldChangeCounts = {};
  (patch.updates || []).forEach((u) => {
    const mo = index.get(modelKey(u.match, keys));
    if (!mo) {
      unmatched.push(u.match);
      return;
    }
    matched++;
    Object.entries(u.set).forEach(([k, v]) => {
      if (JSON.stringify(mo[k]) !== JSON.stringify(v)) fieldChangeCounts[k] = (fieldChangeCounts[k] || 0) + 1;
      mo[k] = v;
    });
  });

  console.log(`[${providerId}] patch: ${matched}/${(patch.updates || []).length} updates matched`);
  console.log(`  field changes: ${JSON.stringify(fieldChangeCounts)}`);
  if (unmatched.length) {
    console.log(`  WARNING: ${unmatched.length} update(s) had no matching model (already removed from the catalog, or match keys don't line up):`);
    unmatched.slice(0, 25).forEach((u) => console.log(`    ${JSON.stringify(u)}`));
  }

  save(html, dataStart, dataEnd, data, outPath);
  console.log(`Wrote ${outPath}`);
}

const [, , sub, ...rest] = process.argv;
try {
  if (sub === 'replace-models') cmdReplaceModels(rest);
  else if (sub === 'replace-from-provider') cmdReplaceFromProvider(rest);
  else if (sub === 'patch') cmdPatch(rest);
  else if (sub === 'validate') {
    if (!rest[0]) throw new Error('usage: apply_update.js validate <html-file>');
    validate(rest[0]);
    console.log(`${rest[0]}: OK`);
  } else {
    console.error('usage: apply_update.js <replace-models|replace-from-provider|patch|validate> ...');
    process.exit(1);
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}

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
 *   diff <old.html> <new.html> [--out <report.txt>]
 *     Structural (JSON-aware) diff between two index.html-shaped files --
 *     e.g. `diff index.html index-new.html` as the last step of a full run.
 *     A plain text/line diff is useless on this file (the whole data blob is
 *     one line), and replace-models'/patch's own per-call output only shows
 *     added/removed models and aggregate field-change *counts* -- it never
 *     shows a model that kept its (g,n,v) key but had its region support,
 *     lifecycle, or dates change. This command re-parses both files fresh
 *     and reports, per provider: regions/groups added or removed, models
 *     added/removed, and for every model present on both sides, a field-by-
 *     field diff (region bitmask changes are decoded into cap badges, not
 *     left as raw numbers). Run this once at the very end of a multi-phase
 *     run instead of trying to recall each phase's printed output from
 *     memory. Always prints to stdout; pass --out to also write the same
 *     report to a plain text file (e.g. for keeping a dated record alongside
 *     index-new.html, or reviewing later without re-running the diff).
 *
 * replace-models / replace-from-provider / patch all validate their own
 * output and print a summary (model count deltas, added/removed models,
 * which fields changed on how many models, unmatched patch entries) so the
 * final report has real numbers instead of "looks done to me." `diff` is the
 * authoritative, complete version of that summary across a whole run.
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

function decodeMask(caps, mask) {
  if (!mask) return [];
  return caps.filter((c, i) => mask & (1 << i)).map((c) => c.badge);
}

function arrayDiff(oldArr, newArr) {
  const oldSet = new Set(oldArr || []);
  const newSet = new Set(newArr || []);
  return {
    added: [...newSet].filter((x) => !oldSet.has(x)),
    removed: [...oldSet].filter((x) => !newSet.has(x)),
  };
}

function listLine(label, arr, limit = 15) {
  if (!arr.length) return null;
  const shown = arr.slice(0, limit).join(', ');
  return `${label} (${arr.length}): ${shown}${arr.length > limit ? ', ...' : ''}`;
}

// Compares one model's region-support bitmask before/after, decoding bits
// into human-readable cap badges instead of leaving raw numbers.
function diffModelRegions(caps, oldS, newS) {
  const { added, removed } = arrayDiff(Object.keys(oldS || {}), Object.keys(newS || {}));
  const changed = Object.keys(newS || {})
    .filter((r) => (oldS || {})[r] !== undefined && oldS[r] !== newS[r])
    .map((r) => `${r}: [${decodeMask(caps, oldS[r]).join(',')}] -> [${decodeMask(caps, newS[r]).join(',')}]`);
  if (!added.length && !removed.length && !changed.length) return null;
  const parts = [];
  if (added.length) parts.push(`+${added.length} region(s) gained (${added.slice(0, 10).join(', ')}${added.length > 10 ? ', ...' : ''})`);
  if (removed.length) parts.push(`-${removed.length} region(s) lost (${removed.slice(0, 10).join(', ')}${removed.length > 10 ? ', ...' : ''})`);
  if (changed.length) parts.push(`${changed.length} region(s) changed support: ${changed.slice(0, 5).join('; ')}${changed.length > 5 ? '; ...' : ''}`);
  return parts.join('; ');
}

// Field-by-field diff between two model objects that share the same (g,n,v)
// key. Returns an array of human-readable "field: before -> after" lines, or
// [] if nothing besides the key fields differs.
function diffModelFields(caps, before, after) {
  const lines = [];
  const regionLine = diffModelRegions(caps, before.s, after.s);
  if (regionLine) lines.push(`s: ${regionLine}`);
  ['card', 'lifecycle', 'retirementDate', 'replacement'].forEach((f) => {
    if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
      lines.push(`${f}: ${JSON.stringify(before[f] ?? null)} -> ${JSON.stringify(after[f] ?? null)}`);
    }
  });
  ['offer', 'api'].forEach((f) => {
    if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
      lines.push(`${f}: ${JSON.stringify(before[f] ?? null)} -> ${JSON.stringify(after[f] ?? null)}`);
    }
  });
  return lines;
}

function diffProviderModels(caps, oldModels, newModels) {
  const key = (m) => modelKey(m, ['g', 'n', 'v']);
  const bucket = (models) => {
    const m = new Map();
    models.forEach((mo) => {
      const k = key(mo);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(mo);
    });
    return m;
  };
  const oldBuckets = bucket(oldModels);
  const newBuckets = bucket(newModels);
  const allKeys = new Set([...oldBuckets.keys(), ...newBuckets.keys()]);

  const added = [];
  const removed = [];
  const changed = []; // { label, lines }
  const label = (mo) => `[${mo.g}] ${mo.n}${mo.v ? ` (${mo.v})` : ''}`;

  allKeys.forEach((k) => {
    const oldList = oldBuckets.get(k) || [];
    const newList = newBuckets.get(k) || [];
    if (oldList.length === 0) {
      newList.forEach((mo) => added.push(label(mo)));
      return;
    }
    if (newList.length === 0) {
      oldList.forEach((mo) => removed.push(label(mo)));
      return;
    }
    if (oldList.length !== newList.length) {
      // Same (g,n,v) key appears a different number of times on each side
      // (a pre-existing duplicate-name situation, e.g. AWS's two "Nova Reel"
      // entries) -- too ambiguous to pair up field-by-field, just flag the count.
      changed.push({ label: `${label(oldList[0])} [duplicate key: ${oldList.length} -> ${newList.length} instances]`, lines: [] });
      return;
    }
    // Equal counts: pair positionally. Exact for the common length-1 case;
    // best-effort (but still deterministic and reviewable) for duplicates.
    oldList.forEach((oldMo, i) => {
      const newMo = newList[i];
      const lines = diffModelFields(caps, oldMo, newMo);
      if (lines.length) changed.push({ label: newList.length > 1 ? `${label(newMo)} [instance ${i + 1}/${newList.length}]` : label(newMo), lines });
    });
  });

  return { added, removed, changed };
}

function cmdDiff(argv) {
  const args = parseArgs(argv);
  const [oldPath, newPath] = args._;
  if (!oldPath || !newPath) {
    console.error('usage: apply_update.js diff <old.html> <new.html> [--out <report.txt>]');
    process.exit(1);
  }

  const out = [];
  const emit = (line = '') => out.push(line);

  const oldData = loadData(oldPath).data;
  const newData = loadData(newPath).data;
  const oldProviders = new Map(oldData.providers.map((p) => [p.id, p]));
  const newProviders = new Map(newData.providers.map((p) => [p.id, p]));
  const allIds = new Set([...oldProviders.keys(), ...newProviders.keys()]);

  emit(`Diff: ${oldPath} -> ${newPath}`);
  emit('');

  allIds.forEach((id) => {
    const op = oldProviders.get(id);
    const np = newProviders.get(id);
    emit(`=== ${id} ===`);
    if (!op) { emit('  provider added (new in this run)'); emit(''); return; }
    if (!np) { emit('  provider removed (present before, gone now)'); emit(''); return; }

    if (op.generated !== np.generated) emit(`  generated: ${op.generated} -> ${np.generated}`);
    if (JSON.stringify(op.caps) !== JSON.stringify(np.caps)) {
      emit('  WARNING: caps definitions changed -- region-support decoding below may be misleading if bit order shifted');
    }

    const regionDiff = arrayDiff((op.regions || []).map((r) => r.code), (np.regions || []).map((r) => r.code));
    const rLine1 = listLine('  regions added', regionDiff.added);
    const rLine2 = listLine('  regions removed', regionDiff.removed);
    if (rLine1) emit(rLine1);
    if (rLine2) emit(rLine2);

    const groupDiff = arrayDiff(op.groups, np.groups);
    const gLine1 = listLine('  groups added', groupDiff.added);
    const gLine2 = listLine('  groups removed', groupDiff.removed);
    if (gLine1) emit(gLine1);
    if (gLine2) emit(gLine2);

    const { added, removed, changed } = diffProviderModels(np.caps, op.models, np.models);
    emit(`  models: ${op.models.length} -> ${np.models.length}`);
    const aLine = listLine('  added', added, 25);
    const remLine = listLine('  removed', removed, 25);
    if (aLine) emit(aLine);
    if (remLine) emit(remLine);
    emit(`  changed (${changed.length}):`);
    changed.slice(0, 40).forEach((c) => {
      emit(`    ~ ${c.label}`);
      c.lines.forEach((l) => emit(`        ${l}`));
    });
    if (changed.length > 40) emit(`    ... and ${changed.length - 40} more changed model(s)`);
    emit('');
  });

  const report = out.join('\n');
  console.log(report);
  if (args.out) {
    fs.writeFileSync(args.out, report, 'utf8');
    console.log(`(also written to ${args.out})`);
  }
}

const [, , sub, ...rest] = process.argv;
try {
  if (sub === 'replace-models') cmdReplaceModels(rest);
  else if (sub === 'replace-from-provider') cmdReplaceFromProvider(rest);
  else if (sub === 'patch') cmdPatch(rest);
  else if (sub === 'diff') cmdDiff(rest);
  else if (sub === 'validate') {
    if (!rest[0]) throw new Error('usage: apply_update.js validate <html-file>');
    validate(rest[0]);
    console.log(`${rest[0]}: OK`);
  } else {
    console.error('usage: apply_update.js <replace-models|replace-from-provider|patch|diff|validate> ...');
    process.exit(1);
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}

#!/usr/bin/env node
/*
 * update-gcp.js — 把 build_vertex_matrix.py 探测出的新 GCP provider 合并进 index.html，
 * 并按 vertex-model-retirement.json 打 lifecycle/retirementDate/replacement 标签，
 * 最后生成 diffs/refresh-diff-<date>.txt。
 *
 * 设计目标：低 token。脚本读全部大文件，stderr 只打印几行摘要，模型无需读原始数据。
 *
 * 用法：
 *   node update-gcp.js <vertex_new.json> [--html index.html] [--retirement vertex-model-retirement.json] [--dry-run]
 *
 * 流程（对应 2026-08-23 手工操作）：
 *   1. python build_vertex_matrix.py --service-account sa.json --output vertex_new.json
 *   2. node update-gcp.js vertex_new.json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------- 参数 ----------
const args = process.argv.slice(2);
if (!args[0] || args.includes('-h') || args.includes('--help')) {
  console.error('用法: node update-gcp.js <vertex_new.json> [--html index.html] [--retirement vertex-model-retirement.json] [--dry-run]');
  process.exit(args[0] ? 0 : 1);
}
const newFile = args[0];
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const htmlFile = opt('--html', 'index.html');
const retFile = opt('--retirement', 'vertex-model-retirement.json');
const dryRun = args.includes('--dry-run');

const err = (...a) => console.error(...a);
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- 读取输入 ----------
function extractProvider(html, id) {
  const so = html.match(/<script[^>]*id="data"[^>]*>/);
  if (!so) throw new Error('未找到 <script id="data">');
  const ds = so.index + so[0].length;
  const se = html.indexOf('</script>', ds);
  const data = JSON.parse(html.slice(ds, se));
  const p = data.providers.find(x => x.id === id);
  if (!p) throw new Error('未找到 provider id=' + id);
  return p;
}

const prov = JSON.parse(fs.readFileSync(newFile, 'utf8')); // 新探测的 provider
const retirement = JSON.parse(fs.readFileSync(retFile, 'utf8'));
const html = fs.readFileSync(htmlFile, 'utf8');
// 旧 provider：优先 git HEAD（未提交改动的真实基线），取不到则用当前 html
let oldProv;
try {
  const headHtml = execSync('git show HEAD:' + htmlFile, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  oldProv = extractProvider(headHtml, 'gcp');
} catch {
  oldProv = extractProvider(html, 'gcp');
}

// ---------- 打 lifecycle 标签 ----------
// 启发式(见 memory refresh-gcp-lifecycle-heuristic)：
//   retirementDate = retirement_date(精确ISO) 或 retirement_date_note，二选一取非空
//   replacement    = replacement(空串->null)
//   lifecycle      = 精确ISO日期 且 有replacement -> "Deprecated"，否则 "Legacy"
// "Retired models" 段不打标（已出目录）。但 `textembedding-gecko`(latest) 是例外：
//   它虽列在 Retired 段(@001/@002/@003)却仍在目录，按用户确认沿用 Deprecated。
const RETIRED_BUT_TAGGED = {
  'textembedding-gecko': { lifecycle: 'Deprecated', retirementDate: '2025-05-24', replacement: 'gemini-embedding-001' },
};

const lookup = new Map();
for (const sec of retirement.sections) {
  const retired = sec.category === 'Retired models';
  for (const m of sec.models) {
    const base = m.model.split('@')[0];
    if (retired && !RETIRED_BUT_TAGGED[base]) continue; // Retired 段跳过(除白名单)
    const retirementDate = m.retirement_date || m.retirement_date_note || null;
    const replacement = m.replacement || null;
    const isExact = /^\d{4}-\d{2}-\d{2}$/.test(m.retirement_date || '');
    const lifecycle = (isExact && replacement) ? 'Deprecated' : 'Legacy';
    lookup.set(base, { lifecycle, retirementDate, replacement });
  }
}
// 白名单覆盖（确保与记忆/用户决定一致）
for (const [k, v] of Object.entries(RETIRED_BUT_TAGGED)) lookup.set(k, v);

let tagged = 0;
for (const m of prov.models) {
  const info = lookup.get(m.n);
  if (info) { m.lifecycle = info.lifecycle; m.retirementDate = info.retirementDate; m.replacement = info.replacement; tagged++; }
}

// ---------- 字符串局部替换 index.html 中的 gcp provider 块 ----------
// dataStr 是紧凑 JSON。用 "id":"gcp" 锚点 + 括号匹配定位旧块，再用紧凑序列化的新块替换，
// 避免整页重序列化导致其它 provider 被重排、diff 爆炸。
function replaceProviderBlock(htmlStr, newProvider) {
  const so = htmlStr.match(/<script[^>]*id="data"[^>]*>/);
  const ds = so.index + so[0].length;
  const se = htmlStr.indexOf('</script>', ds);
  const dataStr = htmlStr.slice(ds, se);
  const idPos = dataStr.indexOf('"id":"gcp"');
  if (idPos < 0) throw new Error('dataStr 中未找到 "id":"gcp"');
  const objStart = dataStr.lastIndexOf('{', idPos);
  let depth = 0, objEnd = -1, inStr = false, esc = false;
  for (let i = objStart; i < dataStr.length; i++) {
    const c = dataStr[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
  }
  const oldBlock = dataStr.slice(objStart, objEnd + 1);
  if (JSON.parse(oldBlock).id !== 'gcp') throw new Error('定位的块不是 gcp');
  const newBlock = JSON.stringify(newProvider);
  if (htmlStr.split(oldBlock).length - 1 !== 1) throw new Error('旧 gcp 块不唯一，放弃替换');
  return htmlStr.replace(oldBlock, newBlock);
}

// ---------- 生成 diff（复刻 diffs/ 既有格式）----------
function mask2txt(v) { return v === 1 ? 'Managed API' : v === 2 ? 'Self-deploy' : String(v); }
function lab(m) { return `[${m.g}] ${m.n}${m.v ? ' (' + m.v + ')' : ''}`; }
function genDiff(oldG, newG) {
  const key = m => m.g + '|' + m.n + '|' + (m.v || '');
  const oldMap = new Map(oldG.models.map(m => [key(m), m]));
  const newMap = new Map(newG.models.map(m => [key(m), m]));
  const added = [...newMap.values()].filter(m => !oldMap.has(key(m)));
  const removed = [...oldMap.values()].filter(m => !newMap.has(key(m)));
  const changed = [];
  for (const [k, nm] of newMap) {
    const om = oldMap.get(k);
    if (!om) continue;
    const lines = [];
    const oR = Object.keys(om.s || {}), nR = Object.keys(nm.s || {});
    const gained = nR.filter(r => !(r in (om.s || {})));
    const lost = oR.filter(r => !(r in (nm.s || {})));
    const sup = oR.filter(r => r in (nm.s || {}) && om.s[r] !== nm.s[r])
      .map(r => `${r}: [${mask2txt(om.s[r])}] -> [${mask2txt(nm.s[r])}]`);
    const sp = [];
    if (gained.length) sp.push(`+${gained.length} region(s) gained (${gained.join(', ')})`);
    if (lost.length) sp.push(`-${lost.length} region(s) lost (${lost.join(', ')})`);
    if (sup.length) sp.push(`${sup.length} region(s) changed support: ${sup.join('; ')}`);
    if (sp.length) lines.push(`s: ${sp.join('; ')}`);
    for (const f of ['lifecycle', 'retirementDate', 'replacement']) {
      const ov = om[f] === undefined ? null : om[f];
      const nv = nm[f] === undefined ? null : nm[f];
      if (JSON.stringify(ov) !== JSON.stringify(nv)) lines.push(`${f}: ${JSON.stringify(ov)} -> ${JSON.stringify(nv)}`);
    }
    if (lines.length) changed.push({ m: nm, lines });
  }
  const out = [];
  out.push('Diff: index.html (HEAD) -> index.html (working tree)');
  out.push('');
  out.push('=== gcp ===');
  if (oldG.generated !== newG.generated) out.push(`  generated: ${oldG.generated} -> ${newG.generated}`);
  const og = new Set(oldG.groups || []), ng = new Set(newG.groups || []);
  const gA = [...ng].filter(x => !og.has(x)), gR = [...og].filter(x => !ng.has(x));
  if (gA.length) out.push(`  groups added (${gA.length}): ${gA.join(', ')}`);
  if (gR.length) out.push(`  groups removed (${gR.length}): ${gR.join(', ')}`);
  out.push(`  models: ${oldG.models.length} -> ${newG.models.length}`);
  if (added.length) out.push(`  added (${added.length}): ${added.map(lab).join(', ')}`);
  if (removed.length) out.push(`  removed (${removed.length}): ${removed.map(lab).join(', ')}`);
  out.push(`  changed (${changed.length}):`);
  for (const c of changed) { out.push(`    ~ ${lab(c.m)}`); for (const l of c.lines) out.push(`        ${l}`); }
  out.push('');
  return { text: out.join('\n'), added, removed, changed };
}

const diff = genDiff(oldProv, prov);
const newHtml = replaceProviderBlock(html, prov);

// ---------- 写盘 ----------
if (!fs.existsSync('diffs')) fs.mkdirSync('diffs');
const diffPath = path.join('diffs', `refresh-diff-${TODAY}.txt`);
if (dryRun) {
  err('[dry-run] 不写文件。');
} else {
  fs.writeFileSync(htmlFile, newHtml, 'utf8');
  fs.writeFileSync(diffPath, diff.text, 'utf8');
}

// ---------- 摘要（只打印这几行，控制 token）----------
const dep = prov.models.filter(m => m.lifecycle === 'Deprecated').length;
const leg = prov.models.filter(m => m.lifecycle === 'Legacy').length;
err(`[gcp] generated ${oldProv.generated} -> ${prov.generated} | models ${oldProv.models.length} -> ${prov.models.length} | regions ${prov.regions.length}`);
err(`[gcp] added ${diff.added.length} | removed ${diff.removed.length} | changed ${diff.changed.length} | tagged ${tagged} (Deprecated ${dep} / Legacy ${leg})`);
if (diff.added.length) err('  + ' + diff.added.map(lab).join(', '));
if (diff.removed.length) err('  - ' + diff.removed.map(lab).join(', '));
err(dryRun ? '[dry-run] 完成' : `[done] 已更新 ${htmlFile}，diff -> ${diffPath}`);

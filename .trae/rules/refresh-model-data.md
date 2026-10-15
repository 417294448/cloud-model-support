> **同步提示**：本 rule 的内容派生自 `.claude/skills/refresh-model-data/SKILL.md`。若 SKILL 中的 i18n 约定、脚本路径、刷新流程或安全校验规则发生变更，请同步更新本 rule，确保两者保持一致。

# cloud-model-support 数据刷新规则

本规则适用于在 Trae 中刷新 `cloud-model-support` 项目的模型数据。所有路径与操作应与 `.claude/skills/refresh-model-data/` 保持一致。

## 核心原则

- **唯一允许修改 `index.html` 数据的是**：`.claude/skills/refresh-model-data/scripts/apply_update.js`
- **禁止直接手工编辑** `<script id="data">` 内的单行长 JSON 数据
- **禁止在数据 blob 内进行中英文翻译**：`subtitle`、`caps[].full`、`note`、`offer.detail` 等字段必须保持英文
- 所有中文翻译必须放在页面内联 JS 的 `PROVIDER_ZH` 映射中（数据 blob 外部）
- 通用 UI 文案翻译放在 `I18N` 字典 / `data-i18n` 属性中
- **数据行之外的手写表现层会在刷新中被原样保留，不要在数据 blob 里改动它们**：顶部右侧浮动控件条 `.ctlbar`（毛玻璃容器，内包 首页/Home 链接、`#langToggle`、`#themeToggle` 三个控件）、`<head>` 的 Google Fonts 字体 `<link>`（Sora / Manrope / JetBrains Mono）、字体变量 `--font-display/--font-body/--font-mono`、语义状态色板 `--c-info/--c-warn/--c-danger/--c-ok/--c-accent2`（明暗两套），以及主题切换后调用 `render()` 经 `statusColors()`/`cssVar()` 重解析状态色的逻辑。状态徽章色（offer/lifecycle/API/对比区块）已从 JS 硬编码改为读 CSS 变量，编辑时不要再写死 `#3fb950`/`#bc8cff` 之类的字面值

## 数据驱动文案的 i18n 分层

| 数据字段 | 英文来源 | 中文翻译位置 | 渲染函数 |
|---------|---------|-------------|---------|
| `subtitle` | `providers[id].subtitle` | `PROVIDER_ZH[id].subtitle` | `providerSubtitle()` |
| `note` | `providers[id].note` | `PROVIDER_ZH[id].note` | `providerNote()` |
| `caps[].full` | `providers[id].caps[k].full` | `PROVIDER_ZH[id].capFull[k]` | `capFullZh(k)` |
| `capDefGroups` 描述 | `capDefGroups[].items[].full` | `PROVIDER_ZH[id].capDefFull[title.label]` | `capDefFullZh(label, full, title)` |
| `capDefGroups` 标题 | `capDefGroups[].title` | `PROVIDER_ZH[id].capDefTitle[title]` | `capDefTitleZh(title)` |

新增云厂商时，必须同步补充 `PROVIDER_ZH[id]` 条目，至少包含 `subtitle`、`note`、`capFull`；使用 `capDefGroups` 时还要补充 `capDefFull` 与 `capDefTitle`。

## 刷新流程

1. **确定范围**：全部刷新（gcp、aws、azure）或仅单个/部分厂商。**只要用户在请求中提供了 GCP 服务账号密钥（`sa.json`，`{"type":"service_account",...}`），无论是否点名 GCP，`gcp` 都无条件计入 scope**——提供凭据本身就是刷新 GCP 的请求，没人会为不想动的厂商提供密钥。绝不能让提供的 `sa.json` 被闲置、而报告称"GCP 不在范围内"。
2. **若 GCP 在范围内**：确认凭据可用。提供了 `sa.json` 时用 `--service-account sa.json`（无需 gcloud、无需交互登录、project 默认取 key 的 `project_id`），此时 **GCP 刷新为必做、不可跳过、不可降级为"仅 AWS/Azure"**；先用一次廉价调用验证凭据（启动 `build_vertex_matrix.py --service-account sa.json` 后看到 `[auth] using service account...` + `[catalog] N entries fetched.` 即认证成功），失败要报出具体原因（401/403、API 未启用、权限不足、key 无效），不要闷头跑 1 万次探测、也不要在用户明确给了 key 时悄悄退回 gcloud。未提供 key 时走 `gcloud` 路径（确认已登录且已设置 project）。
3. **链式写入**：首次调用读取 `index.html` 写入 `index-new.html`，后续阶段读取/写入 `index-new.html`
4. **每个阶段使用对应脚本**：
   - GCP：`build_vertex_matrix.py` + `apply_update.js replace-from-provider`（标准、产出可审阅的 `index-new.html`）；**或** 低 token 单命令 `node update-gcp.js vertex.json`（就地改 `index.html`，一并完成打标签+生成 diff，仅限已 sanity-check 过的 `vertex.json`，且 GCP 单独刷新时——多厂商链式刷新仍用 `apply_update.js`）
   - AWS：fetch_doc.sh + extract_tables.js + `apply_update.js replace-models` / `patch`
   - Azure：`build_azure_models.js` + `apply_update.js replace-models`
5. **最终比对**：`apply_update.js diff index.html index-new.html --out diffs/refresh-diff-YYYY-MM-DD.txt`
6. **升级**：`mv index.html index-old.html && mv index-new.html index.html`

## 关键脚本路径

```text
.claude/skills/refresh-model-data/scripts/apply_update.js
.claude/skills/refresh-model-data/scripts/build_azure_models.js
.claude/skills/refresh-model-data/scripts/extract_tables.js
.claude/skills/refresh-model-data/scripts/fetch_doc.sh
build_vertex_matrix.py
update-gcp.js            # 仓库根目录，GCP 低 token 合并/打标/diff 一体脚本
```

## Token 优化（控制模型上下文消耗）

本 skill 的 token 消耗 ∝ 读进上下文的原始数据量，与 HTTP 探测次数无关（探测是 python 发的网络请求，不耗 token）。大文件是元凶：`vertex_all_models.json` ~5MB（约 127 万 token）、`index.html` ~250KB、`vertex.json` ~60KB。

- **绝不把整个 `vertex_all_models.json` 读进上下文**：只用 `node -e` 提取聚合信息（条目数、新增模型名），打印摘要而非数据
- **能用脚本一次完成就不用多个 `node -e` 内联步骤**：每个内联步骤的中间结果都会被下一步重读，且每次工具往返都重传整个对话
- **后台长任务不要反复 `sleep`+`tail` 轮询**：harness 会在完成时通知，手动轮询每次都烧一整轮对话
- **非平凡 JS 写进 `.js` 文件再 `node file.js`**，别用 `node -e` 内联（Windows 引号转义易错，失败要整个重发）
- **GCP 优先用 `node update-gcp.js`**：把"打 lifecycle 标签 → 替换 gcp 块 → 生成 diff"合并成一条命令，stderr 只打 4 行摘要；产出与标准流程逐字节一致（已验证）

## 安全校验

- 每次写入后 `apply_update.js validate <html>` 必须返回 `OK`
- `apply_update.js replace-from-provider` 只会替换 `models`/`regions`/`groups`/`generated`，不会覆盖 `subtitle`/`caps`/`note`/`capDefGroups`
- 修改 `I18N` 或 `PROVIDER_ZH` 后，必须运行 `apply_update.js validate index.html` 确认内联 JS 语法正确
- GCP lifecycle 标签规则：精确 `retirement_date` + 非空 `replacement` → `Deprecated`，否则 → `Legacy`；「Retired models」段不打标。**例外**：`textembedding-gecko`（目录中仍为 `n=textembedding-gecko v=latest`）虽列于 Retired 段，仍需打 `Deprecated / 2025-05-24 / gemini-embedding-001`（用户 2026-08-23 确认；`update-gcp.js` 已内置此例外）
- **提供了 `sa.json` 的 run，最终报告必须交代 GCP**：要么展示 GCP 的增删/变化，要么显式写"GCP 应请求刷新（已提供服务账号）但失败：<原因>"。报告只列 AWS/Azure、对 GCP 只字未提（而本次提供了 key）= 失败 run，不是范围限定。提供了且可用的服务账号绝不是跳过 GCP 的"合理 blocker"——blocker 理由只适用于凭据缺失/被拒的情形

## Windows 注意事项

- 不要给 Python 传 `/tmp/...` 路径；Node/bash 能解析 `/tmp`，但 Windows Python 不能
- 大文件 JSON（如 `vertex_all_models.json`）用 Node 读取，避免 Python 默认 gbk 编码报错

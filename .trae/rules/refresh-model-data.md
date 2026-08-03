> **同步提示**：本 rule 的内容派生自 `.claude/skills/refresh-model-data/SKILL.md`。若 SKILL 中的 i18n 约定、脚本路径、刷新流程或安全校验规则发生变更，请同步更新本 rule，确保两者保持一致。

# cloud-model-support 数据刷新规则

本规则适用于在 Trae 中刷新 `cloud-model-support` 项目的模型数据。所有路径与操作应与 `.claude/skills/refresh-model-data/` 保持一致。

## 核心原则

- **唯一允许修改 `index.html` 数据的是**：`.claude/skills/refresh-model-data/scripts/apply_update.js`
- **禁止直接手工编辑** `<script id="data">` 内的单行长 JSON 数据
- **禁止在数据 blob 内进行中英文翻译**：`subtitle`、`caps[].full`、`note`、`offer.detail` 等字段必须保持英文
- 所有中文翻译必须放在页面内联 JS 的 `PROVIDER_ZH` 映射中（数据 blob 外部）
- 通用 UI 文案翻译放在 `I18N` 字典 / `data-i18n` 属性中

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

1. **确定范围**：全部刷新（gcp、aws、azure）或仅单个/部分厂商
2. **若 GCP 在范围内**：先确认 `gcloud` 已登录且已设置 project
3. **链式写入**：首次调用读取 `index.html` 写入 `index-new.html`，后续阶段读取/写入 `index-new.html`
4. **每个阶段使用对应脚本**：
   - GCP：`build_vertex_matrix.py` + `apply_update.js replace-from-provider`
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
```

## 安全校验

- 每次写入后 `apply_update.js validate <html>` 必须返回 `OK`
- `apply_update.js replace-from-provider` 只会替换 `models`/`regions`/`groups`/`generated`，不会覆盖 `subtitle`/`caps`/`note`/`capDefGroups`
- 修改 `I18N` 或 `PROVIDER_ZH` 后，必须运行 `apply_update.js validate index.html` 确认内联 JS 语法正确

## Windows 注意事项

- 不要给 Python 传 `/tmp/...` 路径；Node/bash 能解析 `/tmp`，但 Windows Python 不能
- 大文件 JSON（如 `vertex_all_models.json`）用 Node 读取，避免 Python 默认 gbk 编码报错

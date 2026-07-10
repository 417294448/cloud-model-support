# cloud-model-support

AWS Bedrock / Azure Foundry / GCP Vertex AI 三家云厂商的模型 × 区域可用性、生命周期（退役）状态、部署/推理模式对比页面。

**`index.html` 是唯一的产物**：一个不依赖构建工具、不发起任何网络请求的单文件静态页面。所有数据都以 JSON 的形式内嵌在文件里的：

```html
<script id="data" type="application/json">{"providers":[{...aws}, {...azure}, {...gcp}]}</script>
```

页面加载时用 `JSON.parse(document.getElementById("data").textContent)` 读出这段 JSON，此后全部是纯前端渲染，没有任何 fetch/XHR。**本地预览直接双击 `index.html` 即可**（或者 `python -m http.server` 起个静态服务器打开，效果一样）。

其余所有 `.json` 文件都是"原料"或"半成品"——它们本身不会被 `index.html` 读取，而是通过人工/脚本处理后，**手动拼进** `index.html` 内嵌 JSON 里对应 provider 的 `models` 数组（以及 `caps`/`capDefGroups` 等描述字段）。这份文档就是讲清楚：每个模块的数据从哪来、怎么生成、怎么合并回 `index.html`。

## 目录结构一览

| 文件 | 所属模块 | 内容 | 生成方式 |
|---|---|---|---|
| `index.html` | — | 最终页面，内嵌全部数据 | 手工合并各模块数据后的产物 |
| `build_vertex_matrix.py` | GCP | 探测 Vertex AI 模型 × 区域可用性的脚本 | 手写 Python 脚本 |
| `vertex_all_models.json` | GCP | `gcloud ai model-garden models list` 的原始目录快照（624 个模型），作为 `--catalog-file` 复用输入 | `gcloud` 命令输出 |
| `vertex.json` | GCP | `build_vertex_matrix.py` 的输出，可直接作为 `gcp` provider 对象拼进 `index.html` | 脚本生成 |
| `vertex_test.json` | GCP | `--limit` 参数下的小规模测试输出（已 `.gitignore`） | 脚本生成 |
| `vertex-model-retirement.json` | GCP | Gemini/Veo/Embedding 模型的发布日期、退役日期、替代模型 | 抓取官方文档整理 |
| `azure-model-openai-ava.json` | Azure | Azure OpenAI 官方模型在 Global Standard / Data Zone / Regional 三种部署类型下的区域可用性（按 Americas/EMEA/APAC 分 tab） | 抓取官方文档整理 |
| `azure-model-others-ava.json` | Azure | 第三方/社区模型（Anthropic、Meta、Mistral 等）的 serverless 可用性、market 覆盖国家 | 抓取官方文档整理 |
| `azure-model-retirement.json` | Azure | Azure Foundry 模型退役计划（lifecycle/retirement_date/replacement） | 抓取官方文档整理 |
| `aws-model-retirement.json` | AWS | Bedrock 模型的 Legacy/EOL 日期，按 region 分组 | 抓取官方文档整理 |
| `aws-model-runtime&mantle.json` | AWS | 每个 Bedrock 模型是否支持经典 Runtime API / 新的 Mantle API | 抓取官方文档整理 |
| `build.log` / `err.log` | GCP | `build_vertex_matrix.py` 运行日志（已 `.gitignore`） | 脚本运行产物 |

> AWS 和 Azure 目前**没有**类似 `vertex.json` 的"主体模型×区域矩阵"原始文件——它们的模型×区域数据是直接人工/AI 抓取整理后写入 `index.html` 的，过程见下文「Azure 主数据」「AWS 主数据」两节。

## `index.html` 内嵌数据结构

`providers` 数组里每个 provider 对象的关键字段：

| 字段 | 说明 |
|---|---|
| `id` / `name` / `logo` / `accent` / `accentInk` | 标识、显示名、logo key、主题色 |
| `subtitle` | 页头一句话简介，支持内嵌 `<code>`/`<b>` |
| `source` | `{url, label}`，页脚"Data extracted from"链接 |
| `note` | 可选，页脚第二行说明文字（比如"Deprecated 徽章的含义和来源链接"） |
| `axisLabel` / `groupLabel` / `unit` | 轴标签（如 "Inference mode"）、分组标签（如 "Provider"）、单位（"model"） |
| `chipMode` | `"flat"`（AWS，一排 chip）或 `"grouped"`（Azure，按 group 分组的 chip） |
| `caps` | 该 provider 的"能力位"定义数组，每项 `{k, badge, full, color, group, scope?}`，`k` 是位掩码里的键 |
| `pipGroups` | 矩阵视图里色块（pip）分组，`{label, color, keys[]}` |
| `capDefGroups` | 页头"定义卡片"条的数据源，`[{title, items:[{label,color,full}]}]`，没有就不显示这条 |
| `regions` | `[{code, name, group}]` |
| `groups` | 该 provider 下所有 `g`（分组/厂商名）的去重列表 |
| `generated` | 数据快照日期 |
| `models` | 见下表 |

每个 `models[]` 条目的字段：

| 字段 | 说明 |
|---|---|
| `g` | 分组名（AWS/GCP 是模型提供方，如 "Anthropic"；Azure 同理） |
| `n` | 模型名/ID |
| `v` | 版本号，`null` 表示无版本区分 |
| `card` | 模型文档链接，`null` 则不加链接 |
| `s` | `{region_code: bitmask}`，bitmask 由该 provider 的 `caps` 顺序决定（第 i 个 cap 对应 `1<<i`） |
| `lifecycle` | 可选，`"GA"`/`"Preview"`/`"Deprecated"`/`"Legacy"`/`"Retired"`/`"EOL"`，非 `"GA"` 才会显示徽章 |
| `retirementDate` | 可选，配合 `lifecycle` 显示的退役日期（也可以是一段说明文字，如 "No retirement date announced"） |
| `replacement` | 可选，推荐的替代模型文字 |
| `offer` | 可选（目前只有 Azure 在用），`{label, short, detail}`，市场销售范围徽章 |
| `api` | 可选（目前只有 AWS 在用），`{rt: bool, mt: bool}`，是否支持 Runtime API / Mantle API |

## 各模块数据链路详解

### GCP Vertex AI —— 唯一全自动化的模块

```
gcloud ai model-garden models list  ──►  vertex_all_models.json（目录快照，可选缓存）
                                              │
                                              ▼
                        build_vertex_matrix.py（探测每个模型在每个 region 的真实可用性）
                                              │
                                              ▼
                                         vertex.json  ──► 手动整体替换 index.html 里 id=="gcp" 的 provider 对象
```

`gcloud ai model-garden models list` 本身不带 `--region` 参数，返回的是全局目录；要拿到"这个模型在这个 region 是否可用"，只能对每个 `(publisher, model_id, region)` 组合去探测 Vertex AI 的 regional REST 端点：

```
GET https://{region}-aiplatform.googleapis.com/v1/publishers/{publisher}/models/{model_id}
```

`200` = 可用，`404` = 该 region 不可用，`403` = 存在但被 EULA/访问权限挡住（与 region 无关）。

**更新步骤：**

```bash
# 前置条件：本机装好 gcloud CLI，且已 gcloud auth login，有一个可用的 billing/quota project

# 方式一：全量重新拉取目录 + 探测（较慢，几千次 HTTP 请求）
python build_vertex_matrix.py --project <YOUR_PROJECT_ID> --output vertex.json

# 方式二：复用已缓存的目录快照，只重新探测可用性（更快，调试常用）
python build_vertex_matrix.py --project <YOUR_PROJECT_ID> \
  --catalog-file vertex_all_models.json --output vertex.json

# 常用可选参数
#   --regions us-central1,europe-west4      只探测指定 region（默认内置 ~35 个）
#   --workers 30                            并发探测数（默认 30）
#   --limit 20                              只取前 N 个模型，快速冒烟测试用 --output vertex_test.json
```

跑完之后，把 `vertex.json` 的完整 JSON 内容整体替换 `index.html` 内嵌数据里 `providers` 数组中 `id:"gcp"` 的那个对象即可（`vertex.json` 本身的字段就是拼进去后要长的样子，见「合并回 index.html 的通用方法」）。

**Vertex 的模型生命周期数据**（`vertex-model-retirement.json`）是单独抓取的，来源：

- <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions#gemini-models> —— Gemini / Gemini image / Veo / Embeddings 模型的发布日期、退役日期、替代模型

抓取方式是"人工/AI 辅助"而非脚本：用 `curl` 把文档页面整页 HTML 存下来，正则提取 `<table>` 逐行解析成结构化 JSON（各 `<table>` 的表头、所在小节标题决定分类），日期统一转成 `YYYY-MM-DD`，无法精确解析的日期保留原文到 `*_note` 字段。

### Azure Foundry

Azure 目前分成"主数据"（模型×区域可用性）和"生命周期数据"两部分，**均无自动化脚本**，全靠抓文档页面 + 人工整理：

**主数据来源两个文件：**

| 文件 | 来源文档 |
|---|---|
| `azure-model-openai-ava.json` | <https://learn.microsoft.com/en-us/azure/foundry-classic/foundry-models/concepts/models-sold-directly-by-azure-region-availability> —— Azure OpenAI 官方模型，按 Global Standard / Data Zone / Regional 三种部署类型，每种再按 Americas/EMEA/APAC 分 tab，列出每个模型在每个 region 的可用性（`true`/`false`） |
| `azure-model-others-ava.json` | <https://learn.microsoft.com/en-us/azure/foundry-classic/how-to/deploy-models-serverless-availability> —— 第三方/社区 serverless 模型（Anthropic、Meta、Mistral、Cohere 等），按 provider + deployment_type 分组，附市场销售范围国家列表 |

这两个文件是"半结构化的原始抓取结果"，还需要人工转换成 `index.html` 里 Azure provider `models[]` 的 `{g, n, v, s, offer, lifecycle, ...}` 格式（`s` 里的 bitmask 要按 Azure `caps` 定义的 8 种部署类型顺序编码：`gs/dzs/std/gpm/dzpm/rpm/gb/dzb`，见 `index.html` 里 `azure.caps`）。这一步目前没有脚本化，更新时建议：

1. 重新抓取上面两个文档页面（`curl` 整页 HTML，Node 脚本解析 `<table>`），覆盖 `azure-model-openai-ava.json` / `azure-model-others-ava.json`；
2. 和 `index.html` 里现有的 Azure `models[]` 做一次 diff（按 `g`+`n` 对比），手动更新新增/下架/区域变化的模型；
3. 如果懒得手动 diff，也可以整体重新生成 Azure provider 对象再替换（参考「合并回 index.html 的通用方法」的思路自己写一版转换脚本）。

**生命周期数据**（`azure-model-retirement.json`），来源 <https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule>，结构是 `sections[]`（按 category/provider 分组）里每个模型的 `{model, version, lifecycle, retirement_date, replacement}`。合并方式见下方通用流程。

### AWS Bedrock

**主数据**（模型 × In-Region/Geo/Global 推理模式可用性）同样没有独立的原始文件，直接来源 <https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html>，抓取整理后直接写入 `index.html` 里 AWS provider 的 `models[]`（`s` 里的 bitmask 对应 `in`=1 / `geo`=2 / `global`=4）。

**两份附加数据**：

| 文件 | 来源文档 | 内容 |
|---|---|---|
| `aws-model-retirement.json` | <https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html> | 每个模型按 region 分组的 `legacy_date`（进入 Legacy 状态）/ `eol_date`（彻底下线）/ `public_extended_access_start_date` |
| `aws-model-runtime&mantle.json` | <https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html> | 每个模型的 `bedrock_runtime`（经典 Runtime API）/ `bedrock_mantle`（新 Mantle API）布尔支持情况 |

合并方式见下方通用流程；`index.html` 里 AWS 模型的 `lifecycle`/`retirementDate`/`replacement` 用的是 `aws-model-retirement.json`（Legacy→`"Legacy"`，EOL→`"EOL"`），`api.rt`/`api.mt` 用的是 `aws-model-runtime&mantle.json`。

## 合并回 `index.html` 的通用方法

`index.html` 的内嵌 JSON 在文件里是**单独一行**（几十万字符），普通编辑器/`Read` 工具按行读会很卡，**不要手动改这一行**。统一用 Node 脚本读出、改对象、再整体写回：

```js
// merge-example.js —— 以"把某个附加 json 的字段合并进某个 provider 的 models[]"为通用模板
const fs = require('fs');
const path = 'index.html';
const html = fs.readFileSync(path, 'utf8');
const prefix = '<script id="data" type="application/json">';
const suffix = '</script>';
const start = html.indexOf(prefix) + prefix.length;
const end = html.indexOf(suffix, start);
const data = JSON.parse(html.slice(start, end));

const target = data.providers.find(p => p.id === 'aws'); // 'aws' | 'azure' | 'gcp'
const extra = JSON.parse(fs.readFileSync('aws-model-retirement.json', 'utf8'));

// 按 g（分组/provider 名）+ n（模型名）建 key 做匹配，把 extra 里的字段写回 target.models
const lookup = new Map();
extra.models.forEach(m => lookup.set(m.provider + '|' + m.model_name, m));
target.models.forEach(mo => {
  const src = lookup.get(mo.g + '|' + mo.n);
  if (!src) return;
  // ...按需要写 mo.lifecycle / mo.retirementDate / mo.replacement / mo.api 等字段
});

const newHtml = html.slice(0, start) + JSON.stringify(data) + html.slice(end);
fs.writeFileSync(path, newHtml, 'utf8');
```

跑法：`node merge-example.js`。要点：

- **永远用整体 `JSON.stringify(data)` 重新写回**那一行，不要手动拼字符串改局部，否则极易破坏 JSON 转义。
- 匹配 key 优先用 `g`+`n`（分组+模型名）；个别模型名里带 `@version`（如 GCP 的 `multimodalembedding@001`）要额外尝试 `` `${n}@${v}` `` 兜底匹配。
- 合并完用 `node --check` 或 `new Function(...)` 校验 `<script>` 里的主逻辑脚本语法没坏掉，再用浏览器打开肉眼确认。
- 如果某个模型在附加数据源里已经找不到了（比如已经从产品目录下线的老模型），就没有"位置"可以挂徽章——这属于正常情况，不用特殊处理。

**校验脚本模板**（合并后建议都跑一遍）：

```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
JSON.parse(html.match(/<script id=\"data\" type=\"application\/json\">([\s\S]*?)<\/script>/)[1]); // 数据段能 parse
new Function(html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1]);                             // 逻辑脚本语法没坏
console.log('OK');
"
```

## 页面本身的功能速览

- 三个 provider 之间切换（顶部 switcher）会重置所有筛选条件；页面内的四个视图 tab（By Region / Compare Regions / By Model / Full Matrix）切换只清空搜索框和分组筛选，其余筛选保留。
- 每个 provider 的"能力位"（`caps`）定义了模型×区域矩阵里的列含义（AWS 是推理模式，Azure 是部署类型，GCP 是 Managed API/Self-deploy），页头的 `capDefGroups` 卡片给这些概念一句话定义。
- `lifecycle`/`retirementDate`/`replacement`/`offer`/`api` 都是可选字段，缺失就不显示对应徽章，也不会影响"Lifecycle 过滤"/"API surface 过滤"控件的显隐（这些控件由 `P.models.some(...)` 动态判断是否要出现）。

# AI Research Atlas

面向自动驾驶研究者的论文知识图谱与个性化阅读入口。项目重点覆盖端到端自动驾驶、运动规划与控制、世界模型、大模型驾驶、强化学习、自动驾驶竞赛和安全验证等方向，并支持用户按兴趣新增研究方向。

## 当前能力

- 多数据源论文同步：OpenAlex、arXiv、Crossref、Unpaywall；Semantic Scholar 可选
- 网页先启动、论文同步在后台执行，并提供方向进度、新增/更新/无变化统计和错误记录
- 默认 12 小时同步门控；网页按钮和 `--force` 可强制刷新
- 按方向筛选、全文搜索，默认以前沿优先的推荐分数排序
- 一篇论文可同时属于多个研究方向，相关性按“论文-方向”分别判断
- 前沿论文、经典必读、我的推荐三种阅读视图
- 独立的“每日推荐”板块：按用户行为为每个兴趣方向精选 1–2 篇论文
- 可手动打开/关闭研究方向并调整每日推荐权重，同时保留少量相邻方向探索
- 识别顶会/顶刊、预印本、经典论文和同年份高影响论文
- 支持新增自定义方向，例如“自动驾驶幻觉控制”
- 支持导入 Zotero 导出的 BibTeX，作为兴趣样本和论文库
- 论文详情页提供相似论文、OpenAlex 引用/被引扩展、相关性反馈和证据卡
- 支持兴趣簇、全局排除关键词和推荐评估统计
- 支持生成每日 Markdown 摘要，并可选通过 Webhook 或 Telegram 发送
- 保留 DOI、PDF、数据源链接，并按 DOI、arXiv ID、Semantic Scholar ID 和标题年份去重
- 论文卡片显示来源和引用量
- 可选生成中文速览、核心创新点、方法和关键结果
- 支持论文详情、收藏、已读、不感兴趣和个人笔记
- OpenAlex 全网搜索后可直接收藏到 Atlas；收藏时用 DeepSeek 自动推荐研究方向
- 分类结果按论文内容哈希缓存；现有方向自动归档，未知方向只提出新建建议并等待确认
- 每日推荐只使用已经产生的收藏、已读和不感兴趣行为；没有偏好数据时会明确提示，不会伪造个性化结果
- 每日推荐会保存当天快照；支持综合、近 7 天、近 30 天、近 1 年和经典补充筛选，并对较早的用户行为做时间衰减
- 每篇论文显示方向相关性参与推荐的结果、质量等级和推荐理由；页面会展示近 30 天的阅读反馈统计
- 支持本地 SQLite 数据库，不依赖云端数据库

## 快速开始

需要 Node.js 20+。

```bash
npm install
[ -f .env.local ] || cp .env.example .env.local
npm run sync:full

# 强制刷新，忽略同步时间门控
npm run sync:full -- --force

# 完整后台流水线：同步、清理、向量和中文解读
npm run sync:pipeline

# 增量更新 OpenAlex 引用量
npm run sync:incremental

# 回归检查相关性过滤
npm run test:relevance

# 生成每日 Markdown 摘要；配置 Webhook/Telegram 后可选发送
npm run digest:daily
npm run dev -- --port 3210
```

如果 `.env.local` 已经存在，请不要再次执行 `cp .env.example .env.local`，否则会覆盖本地 API Key；直接编辑现有文件即可。

打开 <http://localhost:3210>。

在 macOS 上也可以直接双击项目根目录的 `启动 AI Research Atlas.command`。它会自动检查依赖、读取本机 API 配置、先启动网页，再在后台同步论文、补齐语义向量和生成中文解读。API Key 优先从 `.env.local` 读取，并会自动保存到 macOS 钥匙串作为后续启动的备用配置；密钥不会进入 GitHub。

### 通过 Tailscale 在 iPhone 上访问

Atlas 可以部署在常开着的 Mac 或 Ubuntu 主机上，iPhone 只要加入同一个 Tailscale tailnet，就能在浏览器中查询论文、收藏和打开阅读页面。项目提供了 `启动 AI Research Atlas（Tailscale）.command`（Mac）和 `npm run start:tailscale`（Mac/Ubuntu）：它会启动生产版网页，并用 `tailscale serve` 只在你的 tailnet 内提供 HTTPS 入口，不使用公网 Funnel。

首次配置：

1. 在主机和 iPhone 安装 Tailscale，并登录同一个账号/组织。
2. 在主机运行 `tailscale status`，确认主机在线。
3. Mac 双击 `启动 AI Research Atlas（Tailscale）.command`；Ubuntu 在项目目录运行 `npm run start:tailscale`。
4. 查看命令输出的 `tailscale serve status` 地址，在 iPhone Safari 打开。也可以使用主机的 Tailscale `100.x.y.z` 地址加同一个端口访问，例如 `http://100.x.y.z:3210`。

首次使用 `tailscale serve` 可能会要求在 Tailscale 页面启用 HTTPS 证书。不要使用 `tailscale funnel`，否则会把服务暴露给整个互联网。Tailscale 的访问控制仍由 tailnet ACL 生效；建议只把自己的设备加入 tailnet，并保持 `.env.local`、SQLite 数据库和日志留在主机上。

移动端已提供研究方向抽屉布局，适合 iPhone 查询、收藏和阅读。若希望主机重启后自动启动，可以再把 `npm run start:tailscale` 配置成 macOS launchd 或 Ubuntu systemd 服务。

端口统一由 `.env.local` 中的 `ATLAS_PORT` 控制，默认是 `3210`。如果改成其他端口，普通一键启动和 Tailscale 启动会一起使用新端口；iPhone 通过裸 IP 访问时也使用同一个端口。`tailscale serve status` 输出的 HTTPS 地址通常不需要手动填写端口。

## 数据源配置

在 `.env.local` 中填写：

```env
# OpenAlex：论文发现、引用量、作者和主题元数据
OPENALEX_API_KEY=

# Semantic Scholar：可选，用于补充引用和作者数据
SEMANTIC_SCHOLAR_API_KEY=

# Crossref 和 Unpaywall 不需要 API Key，只需要邮箱
CROSSREF_MAILTO=your-email@example.com
UNPAYWALL_EMAIL=your-email@example.com

DATABASE_PATH=./data/atlas.db

# 本地语义检索模型（首次同步时自动下载）
EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2
TRANSFORMERS_CACHE=./.cache/transformers

# 外部论文接口请求控制
SYNC_REQUEST_TIMEOUT_MS=15000
SYNC_REQUEST_RETRIES=2
```

说明：

- arXiv 不需要注册或 API Key，但它不提供引用量，因此纯 arXiv 记录可能显示“暂无数据”。
- OpenAlex Key 启用后，论文会获得引用量、发表日期和同年份引用百分位；系统不会单纯按总引用量排序。
- 语义检索使用本地多语言 embedding 模型；首次同步会下载模型，之后复用本地缓存。
- Crossref 用于 DOI、期刊/会议元数据校正。
- Unpaywall 用于寻找合法开放获取 PDF。
- `.env.local` 和 `data/*.db` 已被 `.gitignore` 排除，不应提交密钥或本地数据库。
- DeepSeek 配置后，`summarize:papers` 会用 `deepseek-v4-flash` 批量生成中文论文解读；默认并发 8，可通过 `SUMMARY_CONCURRENCY` 调整。
- 新论文收藏后的分类使用 `DEEPSEEK_CLASSIFIER_MODEL`，默认 `deepseek-v4-flash`。分类 prompt 要求模型只能选择 Atlas 当前方向的 key，并根据标题、摘要和发表渠道判断；无法匹配时返回新方向名称和检索词建议。分类结果写入 `paper_classifications`，论文内容没有变化时不会重复调用模型。
- 如果暂时没有配置 `DEEPSEEK_API_KEY`，收藏流程会退回本地关键词规则并明确标注，不会伪造 DeepSeek 结果。论文详情页也可以手动点击“DeepSeek 分类”重试。
- Zotero 建议先导出 BibTeX，再在网页左侧“导入 Zotero/BibTeX”；导入的论文会作为兴趣样本参与后续推荐。
- 详情页的“尝试解析 PDF 全文”使用本机 `pdftotext` 提取开放 PDF；没有 PDF 或解析失败时会回退到摘要级证据。
- `DIGEST_WEBHOOK_URL`、`TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 都是可选配置；不配置时只生成本地 Markdown，不会发送外部消息。

## 同步论文

完整同步所有内置和自定义方向：

```bash
npm run sync:full
```

如果已有论文库、只想补生成语义向量，可以运行：

```bash
npm run embeddings:backfill
```

生成中文论文解读：

```bash
npm run summarize:papers
```

该任务只处理尚未生成或原始摘要发生变化的论文，成功结果会写入 SQLite；没有 `DEEPSEEK_API_KEY` 时会安全跳过，不影响同步和搜索。

### 搜索、收藏与分类

首页搜索框可以切换“搜索本地 Atlas”和“搜索 OpenAlex 全网”。全网结果支持打开 OpenAlex、打开可用 PDF，以及“收藏到 Atlas”。收藏成功后会自动执行一次方向分类：

1. 优先查找同一论文的分类缓存；论文标题、摘要、年份或发表渠道变化后才重新分类。
2. DeepSeek 只能从当前内置/自定义方向中选择 `primary_direction` 和辅助方向，避免把医学等无关论文硬塞进自动驾驶文件夹。
3. 如果当前方向都不适合，页面显示“建议新建研究方向”，你点击确认后才会创建自定义方向并把论文放进去。
4. 论文详情页的“DeepSeek 分类”按钮可以重新查看缓存结果；配置好 API Key 后可再次执行。

分类接口使用结构化 JSON，要求模型返回主方向、辅助方向、置信度、中文理由、证据术语和可选的新方向建议。它不会根据模型自由发挥的会议、引用量或实验结果做分类。

项目内置了 `$atlas-paper-translate` 工作流技能，并已接入论文详情页的“翻译全文”按钮。点击后会在后台下载开放 PDF、提取文本、按段落分块调用 DeepSeek，并把 `source.md`、`translation_zh.md`、`glossary.md` 和 `translation_report.md` 保存到 `data/translations/<paper-id>/`。翻译仍需要配置 DeepSeek、系统安装 `pdftotext`，且论文必须有可访问的 PDF；不会在同步论文时自动翻译全部论文。

网页中的“同步最新论文”按钮和每日任务也调用同一个多源同步器：

```bash
./scripts/sync-daily.sh
```

同步过程会合并不同数据源的同一篇论文，并保留更高的引用量、更完整的摘要和可用 PDF。OpenAlex 和 arXiv 优先抓取最新候选，之后按照方向相关性、时间、会议质量和同年份影响力重新排序。默认 12 小时内不会重复抓取；需要立即刷新时运行 `npm run sync:full -- --force`。新增方向后，再运行一次强制同步即可抓取该方向的论文。

系统内置少量经典必读种子，例如 Attention Is All You Need、BEVFormer、VectorNet、Trajectron++ 和 UniAD。经典论文由可维护的种子清单控制，不会把所有老论文或高引用论文都误标成经典；可在 `src/lib/research-ranking.ts` 中补充或调整。

同步器会对自动驾驶、车辆、机器人、规划、控制、感知等领域锚点做相关性过滤。已有数据库可以运行下面的命令隐藏明显不相关论文；该操作只做标记，不删除原始记录：

```bash
npm run clean:relevance
```

## 新增研究方向

点击左侧“新增”，输入方向名称和搜索关键词。例如：

```text
方向名称：自动驾驶幻觉控制
搜索关键词：autonomous driving hallucination control safety perception uncertainty
```

方向会保存到本地数据库，并在下一次同步时参与论文抓取。

## API

- `GET /api/papers`：论文列表，支持 `direction`、`search` 和 `view=recommended|frontier|classic` 参数
- `GET /api/recommendations`：基于真实 SQLite 论文库的方向推荐
- `GET /api/daily-recommendations`：按兴趣方向生成每日精选；支持 `limit=1|2`，每个方向最多返回 1–2 篇
- `GET|POST /api/direction-preferences`：读取或更新每日推荐方向和权重
- `GET|POST|PATCH|DELETE /api/interest-clusters`：管理多个兴趣簇及其方向组合
- `GET|POST|DELETE /api/exclusion-rules`：管理全局或方向级排除/必选关键词
- `POST /api/library/import`：导入 BibTeX/Zotero 论文样本
- `GET /api/papers/:id/related`：本地相似论文和 OpenAlex 引用/被引关系
- `GET|POST /api/papers/:id/evidence`：读取或缓存结构化证据卡
- `GET /api/papers/:id/relevance`、`POST /api/papers/:id/relevance`：人工相关性标注
- `GET /api/evaluation`：推荐相关性标注和用户反馈统计
- `GET|POST /api/notifications`：查看或保存摘要通知配置
- `GET /api/papers/:id`：论文详情和个人状态
- `POST /api/papers/:id/feedback`：收藏、已读、不感兴趣和笔记
- `GET /api/sync/status`：后台同步进度、新增/更新统计和可恢复错误
- `GET /api/directions`：方向和论文数量
- `POST /api/directions`：新增自定义方向
- `POST /api/sync`：执行多源同步

## 项目结构

```text
src/app/                    Next.js 页面和 API 路由
src/components/             论文卡片、筛选侧栏等 UI
src/lib/research-features.ts 兴趣簇、关系、证据、评估和通知的本地表结构
scripts/sync-multi-source.ts 多源同步、去重和合并
scripts/generate-daily-digest.ts 每日 Markdown/可选通知摘要
data/atlas.db               本地 SQLite 数据库（运行时生成）
.env.example                环境变量模板
MULTI-SOURCE.md             多数据源实现说明
```

## 开发检查

```bash
npx tsc --noEmit --pretty false
npm run build
```

## 数据与引用量说明

“引用: 暂无数据”表示当前数据源没有提供引用量，不等于论文没有被引用。OpenAlex 和 Semantic Scholar 才能提供引用统计；arXiv 主要提供最新预印本、摘要和 PDF。

证据卡当前优先使用论文摘要和已缓存的中文解读，并明确标注置信度；它不是对 PDF 全文逐页解析的替代品。后续接入全文解析后，可以继续写入页码、原文片段和实验表格证据。

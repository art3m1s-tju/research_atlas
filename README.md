# AI Research Atlas

面向自动驾驶研究者的论文知识图谱与个性化阅读入口。项目重点覆盖端到端自动驾驶、运动规划与控制、世界模型、大模型驾驶、强化学习、自动驾驶竞赛和安全验证等方向，并支持用户按兴趣新增研究方向。

## 当前能力

- 多数据源论文同步：OpenAlex、arXiv、Crossref、Unpaywall；Semantic Scholar 可选
- 按方向筛选、全文搜索、引用量排序
- 支持新增自定义方向，例如“自动驾驶幻觉控制”
- 保留 DOI、PDF、数据源链接，并按 DOI、arXiv ID、Semantic Scholar ID 和标题年份去重
- 论文卡片显示来源和引用量
- 可选生成中文速览、核心创新点、方法和关键结果
- 支持本地 SQLite 数据库，不依赖云端数据库

## 快速开始

需要 Node.js 20+。

```bash
npm install
[ -f .env.local ] || cp .env.example .env.local
npm run sync:full
npm run dev -- --port 3100
```

如果 `.env.local` 已经存在，请不要再次执行 `cp .env.example .env.local`，否则会覆盖本地 API Key；直接编辑现有文件即可。

打开 <http://localhost:3100>。

在 macOS 上也可以直接双击项目根目录的 `启动 AI Research Atlas.command`。它会自动检查依赖、读取本机 API 配置、同步论文、补齐语义向量、启动服务并打开浏览器。API Key 优先从 `.env.local` 读取，并会自动保存到 macOS 钥匙串作为后续启动的备用配置；密钥不会进入 GitHub。

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
```

说明：

- arXiv 不需要注册或 API Key，但它不提供引用量，因此纯 arXiv 记录可能显示“暂无数据”。
- OpenAlex Key 启用后，论文会获得引用量并按引用量排序。
- 语义检索使用本地多语言 embedding 模型；首次同步会下载模型，之后复用本地缓存。
- Crossref 用于 DOI、期刊/会议元数据校正。
- Unpaywall 用于寻找合法开放获取 PDF。
- `.env.local` 和 `data/*.db` 已被 `.gitignore` 排除，不应提交密钥或本地数据库。
- DeepSeek 配置后，`summarize:papers` 会用 `deepseek-v4-flash` 批量生成中文论文解读；默认并发 8，可通过 `SUMMARY_CONCURRENCY` 调整。

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

网页中的“同步最新论文”按钮和每日任务也调用同一个多源同步器：

```bash
./scripts/sync-daily.sh
```

同步过程会合并不同数据源的同一篇论文，并保留更高的引用量、更完整的摘要和可用 PDF。新增方向后，再运行一次 `npm run sync:full` 即可抓取该方向的论文。

## 新增研究方向

点击左侧“新增”，输入方向名称和搜索关键词。例如：

```text
方向名称：自动驾驶幻觉控制
搜索关键词：autonomous driving hallucination control safety perception uncertainty
```

方向会保存到本地数据库，并在下一次同步时参与论文抓取。

## API

- `GET /api/papers`：论文列表，支持 `direction` 和 `search` 参数
- `GET /api/directions`：方向和论文数量
- `POST /api/directions`：新增自定义方向
- `POST /api/sync`：执行多源同步

## 项目结构

```text
src/app/                    Next.js 页面和 API 路由
src/components/             论文卡片、筛选侧栏等 UI
scripts/sync-multi-source.ts 多源同步、去重和合并
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

# 多数据源同步说明

项目现在使用统一同步器 `scripts/sync-multi-source.ts`，不会因为某一个服务限流而清空本地论文库。

## 数据源职责

- OpenAlex：论文发现、引用量、主题和作者元数据
- arXiv：最新预印本、摘要和 PDF
- Semantic Scholar：引用补充、作者信息和相关论文元数据
- Crossref：DOI 对应的期刊/会议元数据校正
- Unpaywall：合法开放获取 PDF 链接

## 配置

将下面的变量放入项目根目录 `.env.local`：

```env
OPENALEX_API_KEY=
SEMANTIC_SCHOLAR_API_KEY=
CROSSREF_MAILTO=your-email@example.com
UNPAYWALL_EMAIL=your-email@example.com
```

OpenAlex 和 Semantic Scholar 的 key 都是可选的。没有 key 时，系统仍会使用 arXiv；配置后会自动启用对应数据源。

## 运行

```bash
npm run sync:full
```

网页中的“同步最新论文”和每日定时任务也会调用同一个同步器。

## 去重和合并

系统按以下顺序识别同一篇论文：DOI、arXiv ID、Semantic Scholar ID、OpenAlex ID、规范化标题+年份。

合并时保留更长的摘要、更高的引用数、可用 PDF，并在 `sources` 字段记录来源列表。

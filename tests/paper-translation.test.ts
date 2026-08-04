import assert from "node:assert/strict";
import test from "node:test";
import {
  assessTextExtractionCompleteness,
  extractPaperAffiliations,
  extractPaperAuthorAffiliations,
  annotateStructuredBindings,
  applySemanticBindingDecisions,
  buildStructuredBindingManifest,
  findUnknownProtectedTokens,
  inspectSourceQuality,
  repairSourceQuality,
  normalizeTranslatedMarkdown,
  normalizeTranslatedStructureLabels,
  numberReferenceSection,
  pdfLinksFromLandingHtml,
  prepareTranslationSource,
  protectStructuredMarkdown,
  restoreHeadingLayout,
  restoreCaptionSequence,
  restoreStructuredMarkdown,
  restoreTableLayout,
  splitTranslationChunks,
  stripStructuredBindingMarkers,
  translationPrompt,
  translationSourceHash,
  translationUrlCandidates,
  unwrapReferenceMathBlocks,
  validateTranslatedMarkdown,
  validateTranslatedFragment,
  validateStructuredBindings,
} from "../src/lib/paper-translation";

test("prepareTranslationSource removes only the duplicated leading paper title", () => {
  const title = "A Long Scientific Paper Title";
  const source = `## ${title}\n\nAuthors\n\n## Introduction\n\nBody`;
  assert.equal(prepareTranslationSource(source, title), "Authors\n\n## Introduction\n\nBody");
});

test("prepareTranslationSource converts parser HTML images and assigns semantic heading levels", () => {
  const source = [
    "# Paper",
    "## Methodology",
    "## Overview",
    '<div style="text-align: center;"><img src="assets/figure.png" alt="Image" width="80%" /></div>',
    '<div style="text-align: center;">Figure 1: Architecture.</div>',
    "### Detail",
  ].join("\n\n");
  const prepared = prepareTranslationSource(source, "Paper");
  assert.match(prepared, /^## Methodology/m);
  assert.match(prepared, /^### Overview/m);
  assert.match(prepared, /^#### Detail/m);
  assert.match(prepared, /!\[Image\]\(assets\/figure\.png\)/);
  assert.doesNotMatch(prepared, /<img|<div/);
});

test("prepareTranslationSource removes author front matter and preserves figure-labelled table content", () => {
  const source = [
    "# Paper",
    "Authors $^{1}$",
    "$^{1}$ Affiliation",
    "## Abstract",
    "Abstract text",
    "<table><tr><td>A</td><td>B</td></tr></table>",
    "<div>Figure 1: A table caption.</div>",
    "---",
    "## Introduction",
  ].join("\n\n");
  const prepared = prepareTranslationSource(source, "Paper");
  assert.match(prepared, /^## Abstract/m);
  assert.doesNotMatch(prepared, /Authors|Affiliation|^---$/m);
  assert.match(prepared, /<table|<thead|<th>A<\/th>/);
  assert.match(prepared, /Figure 1: A table caption/);
});

test("extractPaperAffiliations keeps numbered author units for the reader header", () => {
  const source = "# Paper\n\nAuthor $^{1,2}$\n\n$^{1}$ Lab One\n\n$^{2}$ Lab Two\n\n## Abstract\n\nText";
  assert.deepEqual(extractPaperAffiliations(source, "Paper"), [
    { index: 1, text: "Lab One" },
    { index: 2, text: "Lab Two" },
  ]);
});

test("extractPaperAuthorAffiliations preserves author-to-unit markers", () => {
  const source = "# Paper\n\nAlice Smith $^{1,2*}$, Bob Chen $^{2}$, Carol Wu $^{1,3\\dagger}$\n\n$^{1}$ Lab One\n\n$^{2}$ Lab Two\n\n$^{3}$ Lab Three\n\n## Abstract\n\nText";
  assert.deepEqual(extractPaperAuthorAffiliations(source), [
    { name: "Alice Smith", affiliations: [1, 2] },
    { name: "Bob Chen", affiliations: [2] },
    { name: "Carol Wu", affiliations: [1, 3] },
  ]);
});

test("prepareTranslationSource derives hierarchy from common paper numbering", () => {
  const source = [
    "## I. INTRODUCTION",
    "## II. RELATED WORK",
    "## A. Predictive Modeling",
    "## 3 Method",
    "## 3.1 Architecture",
    "## 3.1.1 Encoder",
    "## VIII. CONCLUSION AND FUTURE WORKS",
  ].join("\n\n");
  const prepared = prepareTranslationSource(source, "Different title");
  assert.match(prepared, /^## I\. INTRODUCTION/m);
  assert.match(prepared, /^### A\. Predictive Modeling/m);
  assert.match(prepared, /^## 3 Method/m);
  assert.match(prepared, /^### 3\.1 Architecture/m);
  assert.match(prepared, /^#### 3\.1\.1 Encoder/m);
  assert.match(prepared, /^## VIII\. CONCLUSION AND FUTURE WORKS/m);
});

test("structured placeholders cannot collide after ten formulas", () => {
  const source = Array.from({ length: 12 }, (_, index) => `$x_${index}$`).join(" ");
  const protectedChunk = protectStructuredMarkdown(source);
  assert.equal(protectedChunk.protectedTokens.length, 12);
  assert.equal(restoreStructuredMarkdown(protectedChunk.text, protectedChunk.protectedTokens), source);
  assert.match(protectedChunk.text, /\[\[ATLAS_MATH_000010\]\]/);
});

test("structured placeholders protect figure and table labels from model rewrites", () => {
  const source = "**图 1：** Chart\n\n**表 1：** Results";
  const protectedChunk = protectStructuredMarkdown(source);
  assert.equal(protectedChunk.protectedTokens.filter((item) => item.token.includes("CAPTION")).length, 2);
  assert.equal(restoreStructuredMarkdown(protectedChunk.text, protectedChunk.protectedTokens), source);
});

test("caption placeholders canonicalize English labels", () => {
  const source = "Figure 2: Architecture\n\nTable 3: Results";
  const protectedChunk = protectStructuredMarkdown(source);
  const restored = restoreStructuredMarkdown(protectedChunk.text, protectedChunk.protectedTokens);
  assert.match(restored, /^图 2: Architecture/m);
  assert.match(restored, /^表 3: Results/m);
});

test("complex HTML tables promote all leading header rows", () => {
  const prepared = prepareTranslationSource(
    `<table><tr><td rowspan="2">Method</td><td colspan="2">L2 (m) ↓</td></tr><tr><td>1s</td><td>Avg.</td></tr><tr><td>UniAD (Hu et al. 2023)</td><td>0.5</td><td>1.0</td></tr></table>`,
    "Paper",
  );
  assert.match(prepared, /<thead>[\s\S]*<th>1s<\/th>[\s\S]*<\/thead>/);
  assert.doesNotMatch(prepared, /<\/thead>\s*<tr>\s*<td>1s/);
});

test("structured binding fences keep a figure and its caption atomic", () => {
  const source = [
    "## Results",
    "",
    "![Image](assets/figure-1.png)",
    "",
    "Figure 1: Architecture overview.",
    "",
    "Table 1: Results.",
    "",
    "<table><tr><td>Method</td><td>Score</td></tr></table>",
  ].join("\n");
  const manifest = buildStructuredBindingManifest(source);
  const bound = annotateStructuredBindings(source, manifest);
  assert.equal(manifest.objects.length, 2);
  assert.equal(manifest.ambiguous.length, 0);
  assert.equal(validateStructuredBindings(bound, bound).length, 0);
  assert.match(bound, /ATLAS_BIND_figure-001/);
  assert.match(bound, /ATLAS_BIND_END_table-001/);
  assert.equal(stripStructuredBindingMarkers(bound), source);
  const swapped = bound.replace(/(ATLAS_BIND_figure-001[\s\S]*?ATLAS_BIND_END_figure-001)[\s\S]*(ATLAS_BIND_table-001[\s\S]*?ATLAS_BIND_END_table-001)/, "$2\n$1");
  assert.ok(validateStructuredBindings(bound, swapped).length > 0);
});

test("restoreHeadingLayout enforces source heading depths", () => {
  const source = "## Methodology\n\n### Overview\n\n#### Detail";
  const translated = "## 方法\n\n## 概述\n\n### 细节";
  assert.equal(restoreHeadingLayout(source, translated), "## 方法\n\n### 概述\n\n#### 细节");
});

test("pdfLinksFromLandingHtml resolves OJS citation metadata and download links", () => {
  const html = [
    '<meta content="/index.php/AAAI/article/download/38149/40307" name="citation_pdf_url">',
    '<a href="/index.php/AAAI/article/download/38149/40307">PDF</a>',
    '<a href="/unrelated">Other</a>',
  ].join("\n");
  assert.deepEqual(pdfLinksFromLandingHtml(html, "https://ojs.aaai.org/index.php/AAAI/article/view/38149"), [
    "https://ojs.aaai.org/index.php/AAAI/article/download/38149/40307",
  ]);
});

test("prepareTranslationSource demotes later document-level titles to valid body sections", () => {
  const source = "# Paper\n\n## Introduction\n\nText\n\n# Supplementary Material\n\nMore";
  assert.equal(prepareTranslationSource(source, "Paper"), "## Introduction\n\nText\n\n## Supplementary Material\n\nMore");
});

test("restoreTableLayout keeps valid translated HTML and restores a broken Markdown conversion", () => {
  const source = [
    "<table><tr><td>A</td><td>B</td></tr></table>",
    "Text",
    "<table><tr><td rowspan=\"2\">C</td><td>D</td></tr><tr><td>E</td></tr></table>",
  ].join("\n\n");
  const translated = [
    "<table><tr><td>甲</td><td>乙</td></tr></table>",
    "文本",
    "| 丙 | 丁 |\n|---|---|\n| 戊 |",
  ].join("\n\n");
  const restored = restoreTableLayout(source, translated);
  assert.match(restored, /<td>甲<\/td>/);
  assert.match(restored, /rowspan="2"/);
  assert.doesNotMatch(restored, /^\| 丙/m);
});

test("splitTranslationChunks starts new sections in new chunks and keeps tables atomic", () => {
  const table = "| Metric | Value |\n|---|---|\n| Accuracy | 99 |\n| Recall | 98 |";
  const source = `## Introduction\n\n${"Sentence. ".repeat(10)}\n\n## Results\n\n${table}`;
  const chunks = splitTranslationChunks(source, 90);
  assert.ok(chunks.some((chunk) => chunk.startsWith("## Results")));
  assert.equal(chunks.filter((chunk) => chunk.includes("| Accuracy | 99 |")).length, 1);
  assert.ok(chunks.find((chunk) => chunk.includes("| Accuracy | 99 |"))?.includes("| Recall | 98 |"));
});

test("splitTranslationChunks never cuts oversized HTML tables", () => {
  const table = `<table><tr><td>${"value ".repeat(2000)}</td><td>$x$</td></tr></table>`;
  const chunks = splitTranslationChunks(`## Results\n\n${table}`, 500);
  const tableChunks = chunks.filter((chunk) => chunk.includes("<table>"));
  assert.equal(tableChunks.length, 1);
  assert.match(tableChunks[0], /<\/table>/);
  const protectedTable = protectStructuredMarkdown(tableChunks[0]);
  assert.equal(protectedTable.protectedTokens.filter((item) => item.token.includes("TABLE")).length, 1);
  assert.equal(protectedTable.protectedTokens.filter((item) => item.token.includes("MATH")).length, 0);
});

test("normalization demotes unexpected chunk-level titles instead of deleting them", () => {
  assert.equal(
    normalizeTranslatedMarkdown("# A Comprehensive and Very Long Scientific Paper Title\n\nText"),
    "## A Comprehensive and Very Long Scientific Paper Title\n\nText",
  );
});

test("normalization never treats HTML tables with equals signs as equations", () => {
  const table = "<table style='width: 100%'><tr><td>x = 1</td></tr></table>";
  const normalized = normalizeTranslatedMarkdown(table);
  assert.equal(normalized, table);
  assert.doesNotMatch(normalized, /\$\$/);
});

test("normalization cleans OCR-spaced LaTeX and preserves command spacing", () => {
  const normalized = normalizeTranslatedMarkdown("$$ A d v_{j}^{T_{\\sf t r a j}_{i}}=\\sum_{t\\geq j}r_{t} $$\\n\\n$F_t \\in \\mathbb{R}^{M \\times H}$");
  assert.match(normalized, /A d v|Adv/);
  assert.match(normalized, /\\mathsf\{traj\}/);
  assert.match(normalized, /\\times H/);
  assert.doesNotMatch(normalized, /T_{\\mathsf\{traj\}}_{/);
});

test("normalization keeps independent equations as display-math blocks", () => {
  const normalized = normalizeTranslatedMarkdown("$$ x = y $$");
  assert.equal(normalized, "$$\nx = y\n$$");
});

test("normalization wraps bare single-letter variables in Chinese prose", () => {
  assert.equal(normalizeTranslatedMarkdown("作为条件信号，b 在模块中调节特征融合。"), "作为条件信号，$b$ 在模块中调节特征融合。");
});

test("numberReferenceSection creates ordered bibliography entries", () => {
  const numbered = numberReferenceSection("## 参考文献\n\nFirst reference.\n\nSecond reference.");
  assert.match(numbered, /1\. First reference/);
  assert.match(numbered, /2\. Second reference/);
});

test("translation normalization does not move already-bound captions", () => {
  const normalized = normalizeTranslatedMarkdown("<table><tr><td>x</td></tr></table>\n\n**表 1：** caption\n\n**图 2：** figure\n\n![Image](assets/figure.png)");
  assert.ok(normalized.indexOf("<table") < normalized.indexOf("表 1"));
  assert.ok(normalized.indexOf("图 2") < normalized.indexOf("![Image]"));
});

test("source quality gate rejects repeated OCR output", () => {
  const report = inspectSourceQuality(`## Abstract\n\n${"场景".repeat(1200)}`);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "repeated_text"));
});

test("source repair removes only a dominant repeated OCR tail", () => {
  const source = `A valid paragraph with enough context before the parser failure ${"容量".repeat(400)}\n\ngardless of the specific task configuration.`;
  const repaired = repairSourceQuality(source);
  assert.equal(repaired.repairs.length, 2);
  assert.match(repaired.markdown, /^A valid paragraph with enough context before the parser failure$/m);
  assert.match(repaired.markdown, /^regardless of the specific task configuration\.$/m);
  assert.equal(inspectSourceQuality(repaired.markdown).ok, true);
});

test("source repair leaves ordinary long prose untouched", () => {
  const source = `This is a long but ordinary paragraph containing repeated concepts without an OCR loop. ${"Planning models must balance perception, prediction, and safety. ".repeat(14)}`;
  const repaired = repairSourceQuality(source);
  assert.deepEqual(repaired.repairs, []);
  assert.equal(repaired.markdown, source);
});

test("source repair escapes odd currency dollars without touching math", () => {
  const currency = "Plant disease losses reach about $33 billion in the U.S. every year [122].";
  const repaired = repairSourceQuality(currency);
  assert.ok(repaired.repairs.some((item) => item.code === "currency_dollar_escaped"));
  assert.equal((repaired.markdown.match(/(?<!\\)\$/g) || []).length, 0);
  assert.equal(inspectSourceQuality(repaired.markdown).ok, true);

  const mixed = "Sales reach $12 billion in 2021 and $8.5 billion in 2016.";
  const mixedRepaired = repairSourceQuality(mixed);
  assert.deepEqual(mixedRepaired.repairs, []);
  assert.equal(mixedRepaired.markdown, mixed);

  const math = "Given $x$ and $y$, solve for $z$.";
  const mathRepaired = repairSourceQuality(math);
  assert.deepEqual(mathRepaired.repairs, []);
  assert.equal(mathRepaired.markdown, math);
});

test("text extraction completeness rejects sparse text and lost embedded images", () => {
  const dense = "## Abstract\n\n" + "The quick brown fox jumps over the lazy dog. ".repeat(60);
  assert.equal(assessTextExtractionCompleteness(dense, { pages: 4 }).ok, true);
  const sparse = "Short text.";
  const sparseReport = assessTextExtractionCompleteness(sparse, { pages: 12 });
  assert.equal(sparseReport.ok, false);
  assert.ok(sparseReport.issues.some((issue) => issue.includes("覆盖率过低")));
  const lostImages = assessTextExtractionCompleteness(dense, { pages: 4, embeddedImages: 9 });
  assert.equal(lostImages.ok, false);
  assert.ok(lostImages.issues.some((issue) => issue.includes("嵌入图片")));
  const keptImages = assessTextExtractionCompleteness(`${dense}\n\n![Image](assets/figure-1.png)`, { pages: 4, embeddedImages: 9 });
  assert.equal(keptImages.ok, true);
});

test("semantic table-image decisions resolve a nearby table caption", () => {
  const source = "![Image](assets/table.png)\n\nTable 3: Ablation image";
  const manifest = buildStructuredBindingManifest(source);
  assert.ok(manifest.ambiguous.length > 0);
  applySemanticBindingDecisions(manifest, [{ id: "figure-001", semantic_kind: "table_image", confidence: 0.95, reason: "图片含表格" }]);
  assert.equal(manifest.objects[0].captionKind, "table");
  assert.equal(manifest.objects[0].captionNumber, 3);
});

test("objects without captions are intrinsically bound and never block publication", () => {
  const source = "![Image](assets/figure-1.png)\n\n<table><tr><td>A</td></tr></table>";
  const manifest = buildStructuredBindingManifest(source);
  assert.equal(manifest.captions.length, 0);
  assert.equal(manifest.ambiguous.length, 0);
  assert.equal(manifest.objects[0].kind, "figure");
  assert.equal(manifest.objects[1].kind, "table");
});

test("nearest mismatched caption is retained for semantic review instead of stealing a later caption", () => {
  const source = "Figure 1: OCR mislabeled table caption.\n\n<table><tr><td>A</td></tr></table>\n\nTable 2: Later table.\n\n<table><tr><td>B</td></tr></table>";
  const manifest = buildStructuredBindingManifest(source);
  assert.equal(manifest.objects[0].captionNumber, 1);
  assert.equal(manifest.objects[1].captionNumber, 2);
  assert.ok(manifest.ambiguous.includes("table-001"));
});

test("restoreCaptionSequence uses source order instead of translated caption guesses", () => {
  const source = "Figure 1: Chart\n\nFigure 2: Architecture\n\nTable 1: Results";
  const translated = "**表 1：** Chart\n\n**图 2：** Architecture\n\n**表 5：** Results";
  assert.equal(
    restoreCaptionSequence(source, translated),
    "**图 1：** Chart\n\n**图 2：** Architecture\n\n**表 1：** Results",
  );
});

test("translation prompt includes the project glossary and structural rules", () => {
  const prompt = translationPrompt("## Introduction\n\nText", 1, 2, "world model | 世界模型");
  assert.match(prompt, /world model \| 世界模型/);
  assert.match(prompt, /表格的列数、行数/);
  assert.match(prompt, /作者名/);
  assert.match(prompt, /严禁新增、复制、猜测或重新编号/);
});

test("unknown protected placeholders are detected in model output", () => {
  const known = ["[[ATLAS_BIND_000000]]", "[[ATLAS_TABLE_000004]]"];
  assert.deepEqual(findUnknownProtectedTokens("[[ATLAS_BIND_000000]][[ATLAS_TABLE_000004]]", known), []);
  assert.deepEqual(findUnknownProtectedTokens("[[ATLAS_BIND_000004]][[ATLAS_TABLE_000006]]", known), [
    "[[ATLAS_BIND_000004]]",
    "[[ATLAS_TABLE_000006]]",
  ]);
  assert.deepEqual(findUnknownProtectedTokens("普通文本", known), []);
});

test("reference-like display math is unwrapped while real formulas stay", () => {
  const input = [
    "正文",
    "",
    "$$[293] S. Hosseini and M. Mesbahi, \"Energy-aware aerial surveillance,\" J. Guid., Control, Dyn., vol. 39, no. 9, pp. 1980–1993, 2016. [Online]. Available: http://dx.doi.org/10.2514/1.G001737$$",
    "",
    "$$x=1$$",
  ].join("\n");
  const unwrapped = unwrapReferenceMathBlocks(input);
  assert.match(unwrapped, /^\[293\] S\. Hosseini/m);
  assert.doesNotMatch(unwrapped, /\$\$\[293\]/);
  assert.match(unwrapped, /\$\$x=1\$\$/);
});

test("validator does not flag a formula immediately followed by a table as wrapped math", () => {
  const source = "## Introduction\n\nGiven:\n\n$$x=1$$\n\n<table><tr><td>A</td></tr></table>";
  const translated = "# Title\n\n## 引言\n\n已知：\n\n$$x=1$$\n\n<table><tr><td>A</td></tr></table>";
  const issues = validateTranslatedMarkdown(source, translated, "Title");
  assert.equal(issues.some((issue) => issue.includes("表格被错误包裹在公式块中")), false);
  assert.equal(issues.some((issue) => issue.includes("图片被错误包裹在公式块中")), false);
});

test("normalization does not promote reference lines with URL query equals into math", () => {
  const reference = "[293] S. Hosseini and M. Mesbahi, \"Energy-aware aerial surveillance,\" J. Guid., Control, Dyn., vol. 39, no. 9, pp. 1980–1993, 2016. [在线]。可访问：http://dx.doi.org/10.2514/1.G001737?journalCode=jgcd";
  const normalized = normalizeTranslatedMarkdown(reference);
  assert.doesNotMatch(normalized, /\$\$/);
  assert.match(normalized, /journalCode=jgcd/);
});

test("translation cache hash changes with model, parser settings, and glossary", () => {
  const paper = { title: "Paper", abstract: "Abstract", pdf_url: "https://example.com/paper.pdf", doi: "10.1/example" };
  const baseline = translationSourceHash(paper, { model: "model-a", parser: "docling", formulaEnabled: "1", glossary: "A" });
  assert.notEqual(baseline, translationSourceHash(paper, { model: "model-b", parser: "docling", formulaEnabled: "1", glossary: "A" }));
  assert.notEqual(baseline, translationSourceHash(paper, { model: "model-a", parser: "legacy", formulaEnabled: "1", glossary: "A" }));
  assert.notEqual(baseline, translationSourceHash(paper, { model: "model-a", parser: "docling", formulaEnabled: "1", glossary: "B" }));
});

test("translationUrlCandidates adds a DOI landing source and prefers direct PDFs", () => {
  const candidates = translationUrlCandidates(
    { pdf_url: null, arxiv_id: null, doi: "10.1000/xyz" },
    [],
  );
  assert.ok(candidates.includes("https://doi.org/10.1000/xyz"));
  const mixed = translationUrlCandidates(
    { pdf_url: "https://example.com/paper.pdf", arxiv_id: "2401.00001", doi: "10.1000/xyz" },
    [],
  );
  assert.equal(mixed[0], "https://example.com/paper.pdf");
  assert.ok(mixed.includes("https://arxiv.org/pdf/2401.00001.pdf"));
  assert.equal(new Set(mixed).size, mixed.length);
});

test("strict validation accepts a structurally equivalent translation", () => {
  const title = "Paper Title";
  const source = [
    "## Introduction",
    "",
    "Text with $x = 1$.",
    "",
    "## Results",
    "",
    "| Metric | Value |",
    "|---|---|",
    "| Accuracy | 99 |",
    "",
    "![Image](assets/figure-1.png)",
  ].join("\n");
  const translated = [
    `# ${title}`,
    "",
    "> 原文：https://example.com/paper.pdf",
    "",
    "## 引言",
    "",
    "包含 $x = 1$ 的文本。",
    "",
    "## 结果",
    "",
    "| 指标 | 数值 |",
    "|---|---|",
    "| Accuracy | 99 |",
    "",
    "![Image](assets/figure-1.png)",
  ].join("\n");
  assert.deepEqual(validateTranslatedMarkdown(source, translated, title), []);
});

test("strict validation tracks PaddleOCR HTML image references", () => {
  const title = "Paper Title";
  const source = "## Results\n\n<div><img src=\"assets/figure-1.png\" alt=\"Image\" /></div>";
  const translated = `# ${title}\n\n## 结果\n\n<div><img src=\"assets/figure-1.png\" alt=\"图\" /></div>`;
  assert.deepEqual(validateTranslatedMarkdown(source, translated, title), []);
  assert.ok(validateTranslatedMarkdown(source, translated.replace("figure-1.png", "missing.png"), title).some((issue) => issue.includes("图片引用")));
});

test("strict validation permits inline-math reordering but preserves display-math order", () => {
  const title = "Paper Title";
  const source = "## Methodology\n\nGiven $x$ at time $t$.\n\n$$a=1$$\n\n$$b=2$$";
  const reorderedInline = `# ${title}\n\n## 方法\n\n在时间 $t$ 给定 $x$。\n\n$$a=1$$\n\n$$b=2$$`;
  assert.deepEqual(validateTranslatedMarkdown(source, reorderedInline, title), []);
  const reorderedBlocks = reorderedInline.replace("$$a=1$$\n\n$$b=2$$", "$$b=2$$\n\n$$a=1$$");
  assert.ok(validateTranslatedMarkdown(source, reorderedBlocks, title).some((issue) => issue.includes("块级公式")));
});

test("fragment validation rejects stale caches with invented formulas or missing assets", () => {
  const source = "Text $x$.\n\n![Image](assets/figure.png)";
  assert.deepEqual(validateTranslatedFragment(source, "文本 $x$。\n\n![Image](assets/figure.png)"), []);
  assert.ok(validateTranslatedFragment(source, "文本 $x$ 和 $y$。\n\n![Image](assets/figure.png)").includes("公式内容或数量不一致"));
  assert.ok(validateTranslatedFragment(source, "文本 $x$。\n").includes("图片引用不一致"));
  assert.ok(validateTranslatedFragment(source, "文本 $x$。\n\n[[ATLAS_BIND_000004]][[ATLAS_TABLE_000006]]").includes("存在未恢复的结构化占位符"));
});

test("fragment validation permits required inline wrappers for bare variables", () => {
  assert.deepEqual(validateTranslatedFragment("At time t, parameter b changes.", "在时间 $t$，参数 $b$ 会变化。"), []);
  assert.ok(validateTranslatedFragment("At time t, parameter b changes.", "在时间 $t$，新增 $y = 1$。").some((issue) => issue.includes("公式内容")));
});

test("strict validation catches the observed title, section, table, and continuation failures", () => {
  const source = "## Introduction\n\n## Results\n\n| A | B |\n|---|---|\n| 1 | 2 |";
  const translated = "## 引言\n\n（上接前文）\n\n| A | B |\n|---|---|\n| 1 | 2 | 3 |";
  const issues = validateTranslatedMarkdown(source, translated, "Paper Title");
  assert.ok(issues.some((issue) => issue.includes("标题")));
  assert.ok(issues.some((issue) => issue.includes("章节数量")));
  assert.ok(issues.some((issue) => issue.includes("衔接语")));
  assert.ok(issues.some((issue) => issue.includes("列数")));
});

test("structure labels normalize captions and headings without touching body references", () => {
  const markdown = [
    "### Benchmark",
    "",
    "图 2: 图 4 展示了规划结果。",
    "",
    "**Table 3：** 消融结果。",
    "",
    "## References",
  ].join("\n");
  const normalized = normalizeTranslatedStructureLabels(markdown);
  assert.match(normalized, /### 基准/);
  assert.match(normalized, /\*\*图 2：\*\* 图 4 展示了规划结果。/);
  assert.match(normalized, /\*\*表 3：\*\* 消融结果。/);
  assert.match(normalized, /## 参考文献/);
  assert.match(normalizeTranslatedStructureLabels("<!--ATLAS_BIND_table-008-->Table 8: Caption", true), /ATLAS_BIND_table-008\-\-\>\*\*表 8：\*\*/);
});

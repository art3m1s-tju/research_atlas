import { createHash } from "node:crypto";

export function translationSourceHash(paper: { title: string; abstract?: string | null; pdf_url?: string | null; doi?: string | null }) {
  return createHash("sha256").update([paper.title, paper.abstract || "", paper.pdf_url || "", paper.doi || ""].join("\n")).digest("hex");
}

export function translationDirectory(paperId: number) {
  return `data/translations/${paperId}`;
}

export function splitTranslationChunks(text: string, maxChars = 9000) {
  const paragraphs = text.replace(/\r/g, "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) { chunks.push(current); current = ""; }
      for (let index = 0; index < paragraph.length; index += maxChars) chunks.push(paragraph.slice(index, index + maxChars));
      continue;
    }
    if (current && current.length + paragraph.length + 2 > maxChars) { chunks.push(current); current = ""; }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function translationPrompt(chunk: string, index: number, total: number) {
  return `你是严谨的中文科研论文翻译助手。请把下面论文原文第 ${index}/${total} 个片段翻译成简体中文。

严格要求：
- 只翻译自然语言，不要删减、总结或补写内容。
- 保留章节顺序、段落边界、公式、LaTeX、代码块、表格、引用键、数字、单位、数据集名、模型名和指标名。
- BEV、E2E、VLA、MPC、nuScenes、CARLA 等术语和专有名词保持一致；首次出现可加中文解释。
- 不要输出“翻译如下”等前后说明，不要使用 Markdown 代码围栏包裹整段结果。

原文片段：
${chunk}`;
}

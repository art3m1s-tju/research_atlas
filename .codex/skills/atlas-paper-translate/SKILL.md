---
name: atlas-paper-translate
description: Translate academic papers into accurate Chinese or bilingual Markdown while preserving formulas, code, citations, tables, section structure, and domain terminology. Use when the user asks to translate an arXiv/PDF/Markdown paper, prepare a Chinese reading package, or connect an Atlas paper to a translation workflow.
---

# Atlas Paper Translate

Use this skill for paper reading, not generic document translation. Produce a traceable translation package with the original source, Chinese translation, terminology glossary, and a short verification report. Never invent missing text, experimental results, citations, or venue information.

## Workflow

1. Identify the source. Prefer arXiv HTML/Markdown when available; otherwise use an accessible PDF. Preserve the paper URL, DOI, arXiv ID, and retrieval date.
2. Convert the source into section-aware Markdown. Keep equations, code blocks, tables, figure captions, citations, footnotes, and reference keys unchanged unless the user explicitly asks for localization.
3. Build a terminology glossary before translating. For autonomous driving, keep standard terms such as BEV, VLA, world model, MPC, GRPO, nuScenes, NavSim, closed-loop and open-loop consistent.
4. Translate section by section. Do not translate equation variables, code, BibTeX keys, dataset names, model names, metric names, or citation keys. Translate figure/table captions while retaining their identifiers.
5. Run a verification pass for missing sections, unmatched Markdown fences, changed numbers, broken LaTeX delimiters, inconsistent terminology, and dropped citations.
6. Save a package with `source.md`, `translation_zh.md`, `glossary.md`, and `translation_report.md`. If the source is a PDF, keep the original PDF path or URL; do not redistribute a copyrighted PDF without permission.

## Output rules

- Default target language is Simplified Chinese.
- Prefer literal technical accuracy over elegant paraphrase.
- Keep the English term in parentheses on first use when the Chinese term could be ambiguous.
- Mark OCR uncertainty as `[原文识别不清]`; never guess.
- Mark unsupported claims as `[需要回到原文核对]`.
- For long papers, translate in deterministic chunks and concatenate only after validation.
- Use the existing Atlas cached summary as a reading aid, never as a replacement for the paper text.

## Atlas integration

When the paper comes from AI Research Atlas:

- Use the paper detail page to confirm DOI/PDF/source metadata.
- Store the translation package under `data/translations/<paper-id>/`.
- Reuse the source hash to avoid translating the same unchanged paper twice.
- If `DEEPSEEK_API_KEY` is configured, use the configured DeepSeek model in bounded chunks; otherwise produce the structured source package and report that translation is pending.
- Cache successful chunks and retry only failed chunks.

## Quality gate

Before reporting completion, verify:

- source and translated section counts match;
- all `\(`, `\)`, `\[`, `\]`, `$`, fenced code blocks, and citation keys remain balanced;
- numbers, units, metric names, dataset names, and model names are unchanged;
- glossary terms are used consistently;
- uncertain or unavailable sections are explicitly labeled.

For domain-specific terminology, read [terminology.md](references/terminology.md).

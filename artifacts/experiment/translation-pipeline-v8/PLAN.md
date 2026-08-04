# Translation Pipeline v8

## Objective

Repair the full-paper translation path so that structured PDF reading order is preserved and malformed translations cannot be reported as completed.

## Constraints

- Do not call the external translation API during implementation or verification.
- Keep the existing SQLite and Markdown package format.
- Prefer a surgical pipeline correction over adding more layout-repair heuristics.

## Baseline

- `docling+pdftotext` uses `pdftotext -layout` as the translated body.
- Translation chunks are character-bounded without section awareness.
- The glossary is saved but not supplied to the model.
- Validation findings do not block `completed` status.

## Changes

1. Use Docling Markdown as the primary translation source; retain `pdftotext` only as fallback.
2. Split on Markdown section boundaries and preserve atomic math, table, code, and image blocks.
3. Include the glossary in every translation prompt.
4. Assemble one exact document title and validate structure before completion.
5. Add forced retranslation and server-side in-flight task protection.
6. Add deterministic unit/regression tests for the pure translation helpers.

## Acceptance

- Tests demonstrate that headings and tables remain structurally intact.
- A malformed table, missing section, continuation marker, or missing title fails validation.
- Type checking and the production build pass.
- No external API call is made.


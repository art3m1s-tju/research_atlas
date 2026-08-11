#!/usr/bin/env python3
"""Convert a scientific PDF into structured Markdown and local image assets.

Docling is intentionally optional. The Node translation worker uses this script
when the local parser environment is installed and falls back to pdftotext when
it is not.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling_core.types.doc.base import ImageRefMode
    except ImportError as error:
        print(f"Docling 未安装：{error}", file=sys.stderr)
        return 12

    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = output_dir / "assets"
    if assets_dir.exists():
        shutil.rmtree(assets_dir)
    assets_dir.mkdir(parents=True, exist_ok=True)

    try:
        image_scale = max(1.0, min(4.0, float(os.getenv("TRANSLATION_IMAGE_SCALE", "2.0"))))
    except ValueError:
        image_scale = 2.0

    options = PdfPipelineOptions(
        images_scale=image_scale,
        generate_picture_images=True,
        do_ocr=os.getenv("TRANSLATION_ENABLE_OCR", "0") == "1",
        do_formula_enrichment=os.getenv("TRANSLATION_ENABLE_FORMULA", "1") == "1",
    )
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )
    result = converter.convert(str(Path(args.pdf).resolve()))
    document = result.document
    markdown_path = output_dir / "source_structured.md"
    document.save_as_markdown(
        markdown_path,
        image_mode=ImageRefMode.REFERENCED,
        artifacts_dir=assets_dir,
    )
    markdown = markdown_path.read_text(encoding="utf-8")
    markdown = markdown.replace(f"{assets_dir.as_posix()}/", "assets/")
    markdown = markdown.replace(f"{assets_dir}/", "assets/")
    markdown_path.write_text(markdown, encoding="utf-8")

    # Markdown is a reader export, not the source of structural truth. Keep a
    # lossless Docling document beside it so later stages can use provenance,
    # merged-cell structure, and reading order without guessing from strings.
    docling_json_path = output_dir / "docling_document.json"
    docling_assets_dir = output_dir / "docling_assets"
    try:
        document.save_as_json(
            docling_json_path,
            artifacts_dir=docling_assets_dir,
            image_mode=ImageRefMode.REFERENCED,
        )
    except Exception as error:
        print(f"Docling 原始 JSON 保存失败：{error}", file=sys.stderr)

    assets = [
        str(path.relative_to(output_dir))
        for path in sorted(assets_dir.rglob("*"))
        if path.is_file()
    ]

    layout_items = []
    pages = getattr(document, "pages", {}) or {}
    page_sizes = {}
    page_entries = pages.items() if hasattr(pages, "items") else enumerate(pages, start=1)
    for page_key, page in page_entries:
        page_no = getattr(page, "page_no", None) or page_key
        size = getattr(page, "size", None) or getattr(page, "page_size", None)
        if page_no is None or size is None:
            continue
        page_sizes[int(page_no)] = (float(size.width), float(size.height))

    def asset_reference(item):
        image = getattr(item, "image", None)
        uri = getattr(image, "uri", None) if image is not None else None
        if uri is None:
            return ""
        raw = str(uri)
        try:
            raw = Path(raw).resolve().relative_to(output_dir).as_posix()
        except (ValueError, OSError):
            pass
        return raw

    collections = [
        ("text", getattr(document, "texts", []) or []),
        ("table", getattr(document, "tables", []) or []),
        ("picture", getattr(document, "pictures", []) or []),
    ]
    for kind, items in collections:
        for item_index, item in enumerate(items):
            source_ref = str(getattr(item, "self_ref", "") or f"{kind}-{item_index + 1}")
            label = getattr(item, "label", None)
            text = getattr(item, "text", None)
            for prov_index, prov in enumerate(getattr(item, "prov", []) or []):
                bbox = getattr(prov, "bbox", None)
                page_no = getattr(prov, "page_no", None)
                if bbox is None or page_no is None:
                    continue
                page_width, page_height = page_sizes.get(int(page_no), (None, None))
                layout_items.append({
                    "id": f"{source_ref}#{prov_index + 1}",
                    "source_ref": source_ref,
                    "kind": kind,
                    "page": int(page_no),
                    "order": len(layout_items),
                    "bbox": [float(bbox.l), float(bbox.t), float(bbox.r), float(bbox.b)],
                    "coord_origin": str(getattr(bbox, "coord_origin", "")),
                    "label": getattr(label, "value", str(label or "")),
                    "text": str(text or "") if kind == "text" else "",
                    "page_width": page_width,
                    "page_height": page_height,
                    "asset": asset_reference(item) if kind == "picture" else "",
                })
    layout_path = output_dir / "layout_ir.json"
    layout_path.write_text(json.dumps({
        "version": 2,
        "pages": [
            {"page": page, "width": size[0], "height": size[1]}
            for page, size in sorted(page_sizes.items())
        ],
        "blocks": layout_items,
        "pictures": [item for item in layout_items if item["kind"] == "picture"],
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    manifest = {
        "parser": "docling",
        "parser_version": getattr(__import__("docling"), "__version__", "unknown"),
        "formula_enrichment": options.do_formula_enrichment,
        "source_pdf": str(Path(args.pdf).resolve()),
        "markdown": str(markdown_path.relative_to(output_dir)),
        "assets": assets,
        "page_count": len(page_sizes),
        "docling_document": str(docling_json_path.relative_to(output_dir)),
        "layout_ir": str(layout_path.relative_to(output_dir)),
    }
    (output_dir / "document.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

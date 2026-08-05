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

    assets = [
        str(path.relative_to(output_dir))
        for path in sorted(assets_dir.rglob("*"))
        if path.is_file()
    ]

    layout_items = []
    page_sizes = {
        page.page_no: (float(page.size.width), float(page.size.height))
        for page in document.pages
        if getattr(page, "page_no", None) is not None and getattr(page, "size", None) is not None
    }
    for picture in document.pictures:
        for prov in picture.prov or []:
            bbox = getattr(prov, "bbox", None)
            page_no = getattr(prov, "page_no", None)
            if bbox is None or page_no is None:
                continue
            label = getattr(picture, "label", None)
            page_width, page_height = page_sizes.get(int(page_no), (None, None))
            image = getattr(picture, "image", None)
            asset = getattr(image, "uri", None) or ""
            layout_items.append({
                "kind": "picture",
                "page": int(page_no),
                "bbox": [float(bbox.l), float(bbox.t), float(bbox.r), float(bbox.b)],
                "label": getattr(label, "value", str(label or "")),
                "page_width": page_width,
                "page_height": page_height,
                "asset": asset,
            })
    layout_path = output_dir / "layout_ir.json"
    layout_path.write_text(json.dumps({"version": 1, "pictures": layout_items}, ensure_ascii=False, indent=2), encoding="utf-8")

    manifest = {
        "parser": "docling",
        "parser_version": getattr(__import__("docling"), "__version__", "unknown"),
        "formula_enrichment": options.do_formula_enrichment,
        "source_pdf": str(Path(args.pdf).resolve()),
        "markdown": str(markdown_path.relative_to(output_dir)),
        "assets": assets,
        "layout_ir": str(layout_path.relative_to(output_dir)),
    }
    (output_dir / "document.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Run pdf2zh-next behind a small, machine-readable process boundary."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any


EVENT_PREFIX = "ATLAS_PDF2ZH_EVENT\t"
LATIN_WORD_PATTERN = re.compile(r"[A-Za-z]{5,}")


class TranslationSummaryHandler(logging.Handler):
    """Collect BabelDOC's per-part success/fallback counters."""

    def __init__(self) -> None:
        super().__init__()
        self.summary = {"total_count": 0, "successful_count": 0, "fallback_count": 0}

    def emit(self, record: logging.LogRecord) -> None:
        match = re.search(
            r"Translation completed\. Total: (\d+), Successful: (\d+), Fallback: (\d+)",
            record.getMessage(),
        )
        if not match:
            return
        self.summary["total_count"] += int(match.group(1))
        self.summary["successful_count"] += int(match.group(2))
        self.summary["fallback_count"] += int(match.group(3))


def emit(payload: dict[str, Any]) -> None:
    print(EVENT_PREFIX + json.dumps(payload, ensure_ascii=False, default=str), flush=True)


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def base_url() -> str:
    value = os.getenv("PDF2ZH_API_BASE_URL") or os.getenv("DEEPSEEK_API_BASE_URL") or "https://api.deepseek.com"
    value = value.strip().rstrip("/")
    value = re.sub(r"/chat/completions/?$", "", value).rstrip("/")
    if value == "https://api.deepseek.com":
        value += "/v1"
    return value


def pdf_page_texts(pdf_path: Path) -> list[str]:
    import fitz

    document = fitz.open(pdf_path)
    page_texts = [page.get_text("text") for page in document]
    document.close()
    return page_texts


def pdf_stats(pdf_path: Path, source_page_texts: list[str] | None = None) -> dict[str, int | float]:
    try:
        page_texts = pdf_page_texts(pdf_path)
        text = "\n".join(page_texts)
        stats: dict[str, int | float] = {
            "pages": len(page_texts),
            "text_chars": len(text),
            "cjk_chars": sum(1 for char in text if "\u4e00" <= char <= "\u9fff"),
            "pages_with_cjk": sum(
                1 for page_text in page_texts if any("\u4e00" <= char <= "\u9fff" for char in page_text)
            ),
        }
        if source_page_texts and len(source_page_texts) == len(page_texts):
            overlap_pages = 0
            for source_text, translated_text in zip(source_page_texts, page_texts):
                source_words = set(LATIN_WORD_PATTERN.findall(source_text.lower()))
                translated_words = set(LATIN_WORD_PATTERN.findall(translated_text.lower()))
                if len(source_words) < 20:
                    continue
                overlap_ratio = len(source_words & translated_words) / len(source_words)
                if overlap_ratio >= 0.65:
                    overlap_pages += 1
            stats["pages_with_high_source_overlap"] = overlap_pages
        return stats
    except Exception as error:
        logging.getLogger(__name__).warning("Unable to inspect PDF %s: %s", pdf_path, error)
        return {"pages": 0, "text_chars": 0, "cjk_chars": 0}


def result_value(result: Any, name: str) -> str | None:
    value = getattr(result, name, None)
    if value is None:
        return None
    return str(Path(value).resolve())


def build_settings(pdf_path: Path, output_path: Path, glossary_path: Path | None):
    from pdf2zh_next.config import OpenAISettings
    from pdf2zh_next.config import BasicSettings
    from pdf2zh_next.config import PDFSettings
    from pdf2zh_next.config import SettingsModel
    from pdf2zh_next.config import TranslationSettings

    try:
        qps = max(1, int(os.getenv("PDF2ZH_QPS") or os.getenv("TRANSLATION_CONCURRENCY") or "2"))
    except ValueError:
        qps = 2
    try:
        pool_max_workers = int(os.getenv("PDF2ZH_POOL_MAX_WORKERS") or "0") or None
    except ValueError:
        pool_max_workers = None
    try:
        max_pages_per_part = int(os.getenv("PDF2ZH_MAX_PAGES_PER_PART") or "0") or None
    except ValueError:
        max_pages_per_part = None
    if max_pages_per_part is not None and max_pages_per_part < 50:
        max_pages_per_part = 50

    api_key = os.getenv("PDF2ZH_API_KEY") or os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise ValueError("PDF2ZH_API_KEY 或 DEEPSEEK_API_KEY 未配置")
    model = os.getenv("PDF2ZH_MODEL") or os.getenv("DEEPSEEK_TRANSLATION_MODEL") or os.getenv("DEEPSEEK_MODEL") or "deepseek-v4-flash"
    lang_in = os.getenv("PDF2ZH_LANG_IN") or "en"
    lang_out = os.getenv("PDF2ZH_LANG_OUT") or "zh-CN"

    engine = OpenAISettings(
        openai_model=model,
        openai_base_url=base_url(),
        openai_api_key=api_key,
        openai_enable_json_mode=env_bool("PDF2ZH_ENABLE_JSON_MODE", True),
    )
    translation = TranslationSettings(
        lang_in=lang_in,
        lang_out=lang_out,
        output=str(output_path),
        qps=qps,
        pool_max_workers=pool_max_workers,
        glossaries=str(glossary_path) if glossary_path else None,
        no_auto_extract_glossary=env_bool("PDF2ZH_NO_AUTO_EXTRACT_GLOSSARY", True),
        ignore_cache=env_bool("PDF2ZH_IGNORE_CACHE", False),
        custom_system_prompt=os.getenv("PDF2ZH_CUSTOM_SYSTEM_PROMPT"),
        primary_font_family=os.getenv("PDF2ZH_PRIMARY_FONT_FAMILY"),
    )
    pdf = PDFSettings(
        no_dual=env_bool("PDF2ZH_NO_DUAL", False),
        no_mono=env_bool("PDF2ZH_NO_MONO", False),
        watermark_output_mode=os.getenv("PDF2ZH_WATERMARK_OUTPUT_MODE") or "no_watermark",
        max_pages_per_part=max_pages_per_part,
        translate_table_text=env_bool("PDF2ZH_TRANSLATE_TABLE_TEXT", True),
        auto_enable_ocr_workaround=env_bool("PDF2ZH_AUTO_ENABLE_OCR_WORKAROUND", True),
        enhance_compatibility=env_bool("PDF2ZH_ENHANCE_COMPATIBILITY", False),
    )
    settings = SettingsModel(
        report_interval=max(0.05, float(os.getenv("PDF2ZH_REPORT_INTERVAL") or "0.5")),
        basic=BasicSettings(input_files={str(pdf_path)}, debug=env_bool("PDF2ZH_DEBUG", False)),
        translation=translation,
        pdf=pdf,
        translate_engine_settings=engine,
        term_extraction_engine_settings=None,
    )
    settings.validate_settings()
    return settings


async def translate(args: argparse.Namespace) -> int:
    summary_handler = TranslationSummaryHandler()
    logging.getLogger().addHandler(summary_handler)
    try:
        from pdf2zh_next.high_level import do_translate_async_stream

        pdf_path = Path(args.pdf).resolve()
        output_path = Path(args.output).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
        glossary_path = Path(args.glossary).resolve() if args.glossary else None
        settings = build_settings(pdf_path, output_path, glossary_path)
        finish_result = None
        async for event in do_translate_async_stream(settings, pdf_path):
            event_type = event.get("type") if isinstance(event, dict) else None
            if event_type == "finish":
                finish_result = event.get("translate_result")
                if finish_result is None:
                    raise RuntimeError("pdf2zh-next 完成事件缺少 translate_result")
                result = {
                    "original_pdf_path": result_value(finish_result, "original_pdf_path"),
                    "mono_pdf_path": result_value(finish_result, "mono_pdf_path"),
                    "dual_pdf_path": result_value(finish_result, "dual_pdf_path"),
                    "no_watermark_mono_pdf_path": result_value(finish_result, "no_watermark_mono_pdf_path"),
                    "no_watermark_dual_pdf_path": result_value(finish_result, "no_watermark_dual_pdf_path"),
                    "auto_extracted_glossary_path": result_value(finish_result, "auto_extracted_glossary_path"),
                    "total_seconds": getattr(finish_result, "total_seconds", None),
                    "peak_memory_usage": getattr(finish_result, "peak_memory_usage", None),
                }
                source_page_texts = pdf_page_texts(pdf_path)
                result["stats"] = {
                    "source": pdf_stats(pdf_path),
                    "mono": pdf_stats(Path(result["no_watermark_mono_pdf_path"] or result["mono_pdf_path"]), source_page_texts) if result["no_watermark_mono_pdf_path"] or result["mono_pdf_path"] else {},
                    "dual": pdf_stats(Path(result["no_watermark_dual_pdf_path"] or result["dual_pdf_path"]), source_page_texts) if result["no_watermark_dual_pdf_path"] or result["dual_pdf_path"] else {},
                }
                result["translation_summary"] = summary_handler.summary
                emit({"type": "finish", "translate_result": result, "token_usage": event.get("token_usage", {})})
                break
            if event_type == "error":
                emit({
                    "type": "error",
                    "error": str(event.get("error") or "未知错误"),
                    "error_type": str(event.get("error_type") or "pdf2zhError"),
                    "details": str(event.get("details") or ""),
                })
                return 1
            if isinstance(event, dict):
                emit(event)
        if finish_result is None:
            emit({"type": "error", "error": "pdf2zh-next 未返回完成事件", "error_type": "MissingFinishEvent", "details": ""})
            return 1
        return 0
    except Exception as error:
        emit({"type": "error", "error": str(error), "error_type": type(error).__name__, "details": ""})
        return 1
    finally:
        logging.getLogger().removeHandler(summary_handler)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--glossary")
    args = parser.parse_args()
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    return asyncio.run(translate(args))


if __name__ == "__main__":
    raise SystemExit(main())

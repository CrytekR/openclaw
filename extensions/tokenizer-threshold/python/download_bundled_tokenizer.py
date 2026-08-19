#!/usr/bin/env python3
"""Refresh the bundled DeepSeek-V4-Flash tokenizer files (no model weights).

Usage (from repo root or this directory):
  python3 extensions/tokenizer-threshold/python/download_bundled_tokenizer.py

Requires: pip install huggingface_hub
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

REPO_ID = "deepseek-ai/DeepSeek-V4-Flash"
FILES = ("tokenizer.json", "tokenizer_config.json")
OUT_DIR = Path(__file__).resolve().parent / "bundled" / "deepseek-v4-flash"


def main() -> int:
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("huggingface_hub is required: pip install huggingface_hub", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        path = hf_hub_download(repo_id=REPO_ID, filename=name, local_dir=str(OUT_DIR))
        print(f"downloaded {name} -> {path}")

    cache = OUT_DIR / ".cache"
    if cache.exists():
        shutil.rmtree(cache)
        print(f"removed {cache}")

    missing = [name for name in FILES if not (OUT_DIR / name).is_file()]
    if missing:
        print(f"missing files after download: {missing}", file=sys.stderr)
        return 1
    print(f"bundled tokenizer ready at {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

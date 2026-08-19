#!/usr/bin/env python3
"""Persistent token counter for tokenizer-threshold using Hugging Face transformers.

Protocol (stdin/stdout, one JSON object per line):
  request:  {"op": "ping"} | {"op": "count", "text": "<string>"}
  response: {"ok": true} | {"ok": true, "tokens": <int>} | {"ok": false, "error": "<message>"}

Environment:
  TOKENIZER_THRESHOLD_MODEL  HF id, local directory, or alias (default: bundled deepseek-v4-flash)
  TOKENIZER_THRESHOLD_STUB=1 Use ~chars/4 stub (tests / offline without transformers)

Default model resolves to python/bundled/deepseek-v4-flash (shipped tokenizer files; no network).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_BUNDLED_DIR = Path(__file__).resolve().parent / "bundled" / "deepseek-v4-flash"
_BUNDLED_ALIASES = frozenset(
    {
        "",
        "deepseek-v4-flash",
        "deepseek_v4_flash",
        "deepseek-v4flash",
        "deepseek-ai/deepseek-v4-flash",
        "deepseek-ai/DeepSeek-V4-Flash",
    }
)


def _stub_count(text: str) -> int:
    if not text:
        return 0
    # Match the Node Vitest stub (~chars/4) for offline smoke.
    return max(1, (len(text) + 3) // 4)


def _resolve_model(raw: str) -> tuple[str, bool]:
    """Return (path_or_id, local_files_only)."""
    value = (raw or "").strip()
    if value.lower() in {a.lower() for a in _BUNDLED_ALIASES} or value in _BUNDLED_ALIASES:
        if (_BUNDLED_DIR / "tokenizer.json").is_file():
            return str(_BUNDLED_DIR), True
        # Bundled files missing — fall back to HF id (requires network once).
        return "deepseek-ai/DeepSeek-V4-Flash", False
    path = Path(value).expanduser()
    if path.is_dir() and (path / "tokenizer.json").is_file():
        return str(path.resolve()), True
    return value, False


def _load_tokenizer(model_ref: str, *, local_files_only: bool):
    import transformers

    # Only the tokenizer files are needed; do not load the full MoE weights.
    return transformers.AutoTokenizer.from_pretrained(
        model_ref,
        trust_remote_code=True,
        local_files_only=local_files_only,
    )


def _reply(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    model_raw = os.environ.get("TOKENIZER_THRESHOLD_MODEL", "").strip()
    model_ref, local_files_only = _resolve_model(model_raw)
    stub = os.environ.get("TOKENIZER_THRESHOLD_STUB", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    tokenizer = None
    if not stub:
        try:
            tokenizer = _load_tokenizer(model_ref, local_files_only=local_files_only)
        except Exception as exc:  # noqa: BLE001 — surface load errors to the Node bridge
            # Fail closed on the first ping/count so Node can fall back.
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                _reply(
                    {
                        "ok": False,
                        "error": (
                            f"tokenizer load failed model={model_ref} "
                            f"local_files_only={local_files_only}: {exc}"
                        ),
                    }
                )
            return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op", "count")
            if op == "ping":
                _reply(
                    {
                        "ok": True,
                        "model": model_ref,
                        "local_files_only": local_files_only,
                        "stub": stub,
                    }
                )
                continue
            text = req.get("text", "")
            if not isinstance(text, str):
                text = "" if text is None else str(text)
            if stub or tokenizer is None:
                tokens = _stub_count(text)
            else:
                # add_special_tokens=False keeps counts closer to raw text pressure.
                tokens = len(tokenizer.encode(text, add_special_tokens=False))
            _reply({"ok": True, "tokens": int(tokens)})
        except Exception as exc:  # noqa: BLE001
            _reply({"ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

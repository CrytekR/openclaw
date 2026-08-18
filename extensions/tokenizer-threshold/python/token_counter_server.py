#!/usr/bin/env python3
"""Persistent token counter for tokenizer-threshold using Hugging Face transformers.

Protocol (stdin/stdout, one JSON object per line):
  request:  {"op": "ping"} | {"op": "count", "text": "<string>"}
  response: {"ok": true} | {"ok": true, "tokens": <int>} | {"ok": false, "error": "<message>"}

Environment:
  TOKENIZER_THRESHOLD_MODEL  Hugging Face model id (default: deepseek-ai/DeepSeek-V4-Flash)
  TOKENIZER_THRESHOLD_STUB=1 Use character-length stub (tests / offline)
"""

from __future__ import annotations

import json
import os
import sys


def _stub_count(text: str) -> int:
    if not text:
        return 0
    # Match the Node Vitest stub (~chars/4) for offline smoke.
    return max(1, (len(text) + 3) // 4)


def _load_tokenizer(model_id: str):
    import transformers

    # Only the tokenizer files are needed; do not load the full MoE weights.
    return transformers.AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)


def _reply(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    model_id = (
        os.environ.get("TOKENIZER_THRESHOLD_MODEL", "").strip()
        or "deepseek-ai/DeepSeek-V4-Flash"
    )
    stub = os.environ.get("TOKENIZER_THRESHOLD_STUB", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    tokenizer = None
    if not stub:
        try:
            tokenizer = _load_tokenizer(model_id)
        except Exception as exc:  # noqa: BLE001 — surface load errors to the Node bridge
            # Fail closed on the first ping/count so Node can fall back.
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                _reply({"ok": False, "error": f"tokenizer load failed model={model_id}: {exc}"})
            return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op", "count")
            if op == "ping":
                _reply({"ok": True, "model": model_id, "stub": stub})
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

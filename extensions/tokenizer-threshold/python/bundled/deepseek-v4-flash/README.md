# Bundled DeepSeek-V4-Flash tokenizer

Source: https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash

Files (tokenizer only — no model weights):

- `tokenizer.json`
- `tokenizer_config.json`

Refresh:

```bash
python3 extensions/tokenizer-threshold/python/download_bundled_tokenizer.py
```

Runtime loads this directory with `local_files_only=True` when
`tokenizerModel` is `deepseek-v4-flash` (default) or the HF id
`deepseek-ai/DeepSeek-V4-Flash`.

"""Offline translation for the English movie summaries in the local archive."""

from __future__ import annotations

from contextlib import ExitStack
from functools import lru_cache
from pathlib import Path
from threading import Lock
import json
import re


MODELS_DIR = Path(__file__).resolve().parent / 'data' / 'translation'
_model_lock = Lock()
_language_lock = Lock()


@lru_cache(maxsize=3)
def _load_model(language):
    import ctranslate2
    import sentencepiece

    directory = MODELS_DIR / language
    hplt = language == 'tr-hplt'
    if hplt:
        source = sentencepiece.SentencePieceProcessor(model_proto=(directory / 'source.spm').read_bytes())
        target = sentencepiece.SentencePieceProcessor(model_proto=(directory / 'target.spm').read_bytes())
        model_files = [directory / name for name in ('model.bin', 'config.json', 'shared_vocabulary.json')]
        prefix = ''
    else:
        source = target = sentencepiece.SentencePieceProcessor(
            model_proto=(directory / 'sentencepiece.model').read_bytes()
        )
        model_files = [path for path in (directory / 'model').iterdir() if path.is_file()]
        metadata = json.loads((directory / 'metadata.json').read_text(encoding='utf-8'))
        prefix = metadata.get('target_prefix') or ''

    # Python opens the files so Windows paths with non-ASCII characters also work.
    with ExitStack() as stack:
        files = {path.name: stack.enter_context(path.open('rb')) for path in model_files}
        translator = ctranslate2.Translator(
            language, files=files, device='cpu', intra_threads=2, compute_type='int8'
        )
    return translator, source, target, prefix


def translate_locally(text: str, target: str) -> str | None:
    language = 'zh' if target == 'zh-CN' else target
    if target == 'tr' and (MODELS_DIR / 'tr-hplt' / '.ready').is_file():
        language = 'tr-hplt'
    directory = MODELS_DIR / language
    if target != 'en' and not (directory / '.ready').is_file():
        return None

    try:
        from langdetect import DetectorFactory, LangDetectException, detect
    except ImportError:
        return None

    try:
        with _language_lock:
            DetectorFactory.seed = 0
            source = detect(text)
    except LangDetectException:
        return None
    if source == target.lower():
        return text
    if source != 'en':
        return None

    try:
        with _model_lock:
            translator, source_tokenizer, target_tokenizer, prefix = _load_model(language)
        parts = []
        for sentence in re.split(r'(?<=[.!?])\s+', text):
            tokens = source_tokenizer.encode(sentence, out_type=str)
            parts.extend(tokens[i:i + 384] for i in range(0, len(tokens), 384))
        if language == 'tr-hplt':
            parts = [part + ['</s>'] for part in parts]
        results = translator.translate_batch(
            parts, target_prefix=[[prefix]] * len(parts) if prefix else None,
            beam_size=3, replace_unknowns=True, max_batch_size=768, batch_type='tokens',
            max_input_length=385, max_decoding_length=512,
        )
        segments = [
            target_tokenizer.decode(result.hypotheses[0]).replace('▁', ' ').strip().removeprefix(prefix).strip()
            for result in results
        ]
        translated = ' '.join(segments)
        return translated if all(segments) and translated.casefold() != text.casefold() else None
    except (ImportError, OSError, RuntimeError, ValueError, IndexError):
        return None

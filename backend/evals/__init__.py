"""Offline-first quality evaluation for ASL gloss → English translation.

Nothing in this package changes how ``POST /translate`` behaves. It feeds a
fixed set of synthetic gloss sequences through a translator (canned reference
answers, recorded outputs, or, only when explicitly enabled, the production
Gemini translator) and scores the English with deterministic checks.

Run ``python -m evals --help`` from ``backend/``. See ``evals/README.md``.
"""

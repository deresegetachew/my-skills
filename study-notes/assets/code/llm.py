"""get_completion() for study-notes notebooks, using Google Colab's built-in models.

No API key needed: Colab provides the models (google.colab.ai), so these notebooks are meant
to run in Colab. In the setup cell, check_setup() lists the available models; pick one with
use_model("google/...") or leave it unset for Colab's default.
"""
from __future__ import annotations

_model: str | None = None


def _colab_ai():
    try:
        from google.colab import ai
    except ImportError:
        raise RuntimeError("This notebook calls Colab's built-in models: open it in Google Colab.") from None
    return ai


def use_model(name: str | None) -> None:
    """Choose the model for every get_completion() call (None = Colab's default)."""
    global _model
    _model = name


def check_setup() -> None:
    """Print whether Colab's built-in models are available, the models, and the one in use."""
    try:
        ai = _colab_ai()
    except RuntimeError as e:
        print(f"✗ {e}")
        return
    models = ai.list_models()
    if _model and _model not in models:
        raise ValueError(f"use_model({_model!r}): not available here. Choose one of: {', '.join(models)}")
    print(f"✓ Colab built-in models · using: {_model or 'Colab default'}")
    print(f"  available: {', '.join(models)}")


def get_completion(messages=None, system_prompt=None, user_prompt=None, model=None) -> str:
    """Same call style as the course notebooks' helper; returns the reply text.

    Colab's generate_text takes a single prompt, so chat messages are joined with their roles."""
    messages = list(messages or [])
    if system_prompt:
        messages.insert(0, {"role": "system", "content": system_prompt})
    if user_prompt:
        messages.append({"role": "user", "content": user_prompt})
    prompt = "\n\n".join(f"{m['role'].upper()}:\n{m['content']}" for m in messages) + "\n\nASSISTANT:\n"

    chosen = model or _model
    return _colab_ai().generate_text(prompt, **({"model_name": chosen} if chosen else {}))

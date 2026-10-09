"""get_completion() for study-notes notebooks.

In Google Colab it uses Colab's built-in models (google.colab.ai): no API key needed.
Outside Colab (or to override), set an environment variable / Colab secret:

    GEMINI_API_KEY   use Gemini through Google AI Studio
    OPENAI_API_KEY   use OpenAI
    LLM_MODEL        pick a specific model (optional)

Run check_setup() first: it reports which LLM will be used, or exactly why none is available.
"""
from __future__ import annotations

import os

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEFAULT_MODELS = {"gemini": "gemini-2.5-flash", "openai": "gpt-4.1-mini"}

_colab_error: str | None = None


def setting(name: str) -> str | None:
    """Environment variable first, then Colab Secrets (when running in Colab)."""
    if os.getenv(name):
        return os.getenv(name)
    try:
        from google.colab import userdata
        return userdata.get(name) or None
    except Exception:
        return None


def in_colab() -> bool:
    try:
        import google.colab  # noqa: F401
        return True
    except ImportError:
        return False


def _colab_ai():
    """Colab's built-in model access, or None (the reason is kept for check_setup)."""
    global _colab_error
    try:
        from google.colab import ai
        _colab_error = None
        return ai
    except Exception as e:
        _colab_error = f"{type(e).__name__}: {e}"
        return None


def provider() -> str | None:
    """Which LLM get_completion() will use: an explicit key wins, then Colab's built-in."""
    if setting("GEMINI_API_KEY"):
        return "gemini"
    if setting("OPENAI_API_KEY"):
        return "openai"
    if in_colab() and _colab_ai() is not None:
        return "colab"
    return None


def check_setup(require: bool = True) -> None:
    """Print which LLM will be used. With require=True, stop with instructions if none is."""
    p = provider()
    model = setting("LLM_MODEL")
    if p == "colab":
        ai = _colab_ai()
        print(f"✓ LLM: Colab built-in models (no key needed) · model: {model or 'Colab default'}")
        try:
            print(f"  available models: {', '.join(ai.list_models())}")
        except Exception:
            pass
    elif p:
        print(f"✓ LLM: {p} via API key · model: {model or DEFAULT_MODELS[p]}")
    else:
        where = "in this Colab session" if in_colab() else "on this machine"
        print(f"✗ No LLM available {where}.")
        if in_colab():
            print(f"  google.colab.ai could not be used: {_colab_error}")
        if require:
            raise RuntimeError(
                "No LLM available.\n"
                "In Colab: the built-in models (google.colab.ai) aren't available to this account; "
                "add GEMINI_API_KEY in Secrets (key icon, left sidebar) with Notebook access on.\n"
                "Locally: export GEMINI_API_KEY=... (or OPENAI_API_KEY) before starting Jupyter.")


def _as_prompt(messages: list[dict]) -> str:
    """Colab's generate_text takes one prompt string; keep the roles visible in it."""
    parts = [f"{m['role'].upper()}:\n{m['content']}" for m in messages]
    return "\n\n".join(parts) + "\n\nASSISTANT:\n"


def get_completion(messages=None, system_prompt=None, user_prompt=None, model=None,
                   temperature: float = 0) -> str:
    """Same signature as the course notebooks' helper. Returns the reply text."""
    messages = list(messages or [])
    if system_prompt:
        messages.insert(0, {"role": "system", "content": system_prompt})
    if user_prompt:
        messages.append({"role": "user", "content": user_prompt})
    model = model or setting("LLM_MODEL")

    p = provider()
    if p == "colab":
        kwargs = {"model_name": model} if model else {}
        return _colab_ai().generate_text(_as_prompt(messages), **kwargs)
    if p in ("gemini", "openai"):
        from openai import OpenAI  # Gemini's API also accepts the OpenAI client
        client = OpenAI(api_key=setting(f"{p.upper()}_API_KEY"),
                        base_url=GEMINI_BASE_URL if p == "gemini" else None)
        response = client.chat.completions.create(
            model=model or DEFAULT_MODELS[p], messages=messages, temperature=temperature)
        return response.choices[0].message.content
    check_setup(require=True)  # raises with instructions

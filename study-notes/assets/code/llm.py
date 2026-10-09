"""get_completion() for study-notes notebooks: the same code runs locally and in Colab.

Which LLM answers is decided by settings, read from environment variables or, in Colab,
from the Secrets panel (key icon in the left sidebar):

    LLM_PROVIDER   "gemini" | "openai" | "vocareum" | "mock"   (optional, see below)
    GEMINI_API_KEY key for Gemini (Google AI Studio)
    OPENAI_API_KEY key for OpenAI, or your Vocareum key with LLM_PROVIDER=vocareum
    LLM_MODEL      override the provider's default model (optional)

Without LLM_PROVIDER, the provider follows whichever key is set; with no key at all, only
scripted replies work. Scripted replies (set_mock_replies) always take priority, so a demo
cell that scripts specific outputs behaves the same with or without a key.
"""
from __future__ import annotations

import os
from collections import deque

PROVIDERS = {
    "gemini":   {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
                 "key": "GEMINI_API_KEY", "model": "gemini-2.5-flash"},
    "openai":   {"base_url": None, "key": "OPENAI_API_KEY", "model": "gpt-4.1-mini"},
    "vocareum": {"base_url": "https://openai.vocareum.com/v1",
                 "key": "OPENAI_API_KEY", "model": "gpt-4.1-nano"},
}

_scripted: deque[str] = deque()


def setting(name: str, default: str | None = None) -> str | None:
    """Read a setting from the environment, then from Colab Secrets if running in Colab."""
    if os.getenv(name):
        return os.getenv(name)
    try:
        from google.colab import userdata  # only exists inside Colab
        return userdata.get(name) or default
    except Exception:                      # not in Colab, secret missing, or access not granted
        return default


def provider() -> str:
    explicit = setting("LLM_PROVIDER")
    if explicit:
        return explicit.lower()
    if setting("GEMINI_API_KEY"):
        return "gemini"
    if setting("OPENAI_API_KEY"):
        return "openai"
    return "mock"


def set_mock_replies(*replies: str) -> None:
    """Script the next replies. They are used before any real provider is called."""
    _scripted.clear()
    _scripted.extend(replies)


def describe() -> str:
    p = provider()
    if p == "mock":
        return "LLM: mock (no API key found; only scripted replies are available)"
    cfg = PROVIDERS[p]
    return f"LLM: {p} · model {setting('LLM_MODEL') or cfg['model']}"


def get_completion(messages=None, system_prompt=None, user_prompt=None, model=None,
                   temperature: float = 0) -> str:
    """Same signature as the course notebooks' helper. Returns the reply text."""
    if _scripted:
        return _scripted.popleft()

    p = provider()
    if p == "mock":
        raise RuntimeError("No API key found and no scripted replies left. Add GEMINI_API_KEY or "
                           "OPENAI_API_KEY (env var or Colab Secrets), or call set_mock_replies(...).")
    cfg = PROVIDERS[p]

    messages = list(messages or [])
    if system_prompt:
        messages.insert(0, {"role": "system", "content": system_prompt})
    if user_prompt:
        messages.append({"role": "user", "content": user_prompt})

    from openai import OpenAI  # Gemini and Vocareum both speak the OpenAI API
    client = OpenAI(api_key=setting(cfg["key"]), base_url=cfg["base_url"])
    response = client.chat.completions.create(
        model=model or setting("LLM_MODEL") or cfg["model"],
        messages=messages,
        temperature=temperature,
    )
    return response.choices[0].message.content

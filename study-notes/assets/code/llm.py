"""get_completion() for study-notes notebooks: the same code runs locally and in Colab.

Which LLM answers is decided by settings, read from environment variables or, in Colab,
from the Secrets panel (key icon in the left sidebar):

    LLM_PROVIDER   "colab" | "gemini" | "openai" | "vocareum" | "mock"   (optional, see below)
    GEMINI_API_KEY key for Gemini (Google AI Studio)
    OPENAI_API_KEY key for OpenAI, or your Vocareum key with LLM_PROVIDER=vocareum
    LLM_MODEL      override the provider's default model (optional)

Without LLM_PROVIDER, the provider follows whichever key is set; with no key, Colab's
built-in models are used when running in Colab (google.colab.ai, no key needed, availability
depends on your Colab plan); otherwise only scripted replies work. Scripted replies (set_mock_replies) always take priority, so a demo
cell that scripts specific outputs behaves the same with or without a key.

Call check_setup() in a notebook's setup cell to see what was found (and why something is
missing), and check_setup(require_key=True) at the top of cells that need a real model.
"""
from __future__ import annotations

import os
from collections import deque

PROVIDERS = {
    # Colab's built-in model access: an OpenAI-compatible proxy whose host and token
    # Colab sets in the environment when google.colab.ai is imported. No key needed.
    "colab":    {"base_url": None, "key": "MODEL_PROXY_API_KEY", "model": "google/gemini-2.5-flash"},
    "gemini":   {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
                 "key": "GEMINI_API_KEY", "model": "gemini-2.5-flash"},
    "openai":   {"base_url": None, "key": "OPENAI_API_KEY", "model": "gpt-4.1-mini"},
    "vocareum": {"base_url": "https://openai.vocareum.com/v1",
                 "key": "OPENAI_API_KEY", "model": "gpt-4.1-nano"},
}

_scripted: deque[str] = deque()
_why_missing: dict[str, str] = {}


def setting(name: str, default: str | None = None) -> str | None:
    """Read a setting from the environment, then from Colab Secrets if running in Colab."""
    if os.getenv(name):
        return os.getenv(name)
    try:
        from google.colab import userdata  # only exists inside Colab
    except ImportError:
        _why_missing[name] = "not set as an environment variable"
        return default
    try:
        return userdata.get(name) or default
    except Exception as e:                 # Colab raises different errors for each case
        kind = type(e).__name__
        if "NotebookAccess" in kind:
            _why_missing[name] = "secret exists, but Notebook access is switched off for it"
        elif "NotFound" in kind:
            _why_missing[name] = "no Colab secret with this name"
        else:
            _why_missing[name] = f"could not be read ({kind})"
        return default


def _source(name: str) -> str:
    if os.getenv(name):
        return "environment variable"
    return "Colab secret"


def check_setup(require_key: bool = False) -> str:
    """Report which LLM settings were found. With require_key=True, stop with clear
    instructions if no usable API key is configured (call it before real-model cells)."""
    lines = []
    for name in ("LLM_PROVIDER", "GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_MODEL"):
        value = setting(name)
        if value:
            shown = value if name in ("LLM_PROVIDER", "LLM_MODEL") else value[:4] + "…" + value[-2:]
            lines.append(f"  ✓ {name:15} {shown}  ({_source(name)})")
        else:
            lines.append(f"  · {name:15} not found: {_why_missing.get(name, 'not set')}")
    p = provider()
    usable = (p == "colab" and colab_ai_available()) or (
        p not in ("mock", "colab") and setting(PROVIDERS[p]["key"]) is not None)
    status = describe() if p != "mock" else "LLM: mock (scripted replies only)"
    report = status + "\n" + "\n".join(lines)
    print(report)

    if require_key and not usable:
        raise RuntimeError(
            "This cell needs a real LLM, but none is available.\n"
            "In Colab: built-in models (google.colab.ai) aren't available on this account/plan, so\n"
            "click the key icon (Secrets) in the left sidebar, add GEMINI_API_KEY or OPENAI_API_KEY,\n"
            "switch on 'Notebook access' for it, then re-run the setup cell.\n"
            "Locally: export GEMINI_API_KEY=... (or OPENAI_API_KEY) before starting Jupyter.")
    if p not in ("mock", "colab") and not usable:
        print(f"  ! LLM_PROVIDER={p} but its key ({PROVIDERS[p]['key']}) is missing")
    if p == "colab" and not usable:
        print("  ! LLM_PROVIDER=colab but Colab's built-in models aren't available here")
    return report


def colab_ai_available() -> bool:
    """True inside Colab when the built-in model proxy (google.colab.ai) is set up."""
    try:
        from google.colab import ai  # noqa: F401  (importing it sets MODEL_PROXY_*)
    except Exception:
        return False
    return bool(os.getenv("MODEL_PROXY_HOST") and os.getenv("MODEL_PROXY_API_KEY"))


def provider() -> str:
    explicit = setting("LLM_PROVIDER")
    if explicit:
        if explicit.lower() not in (*PROVIDERS, "mock"):
            raise ValueError(f"LLM_PROVIDER={explicit!r}: use one of {', '.join([*PROVIDERS, 'mock'])}")
        return explicit.lower()
    if setting("GEMINI_API_KEY"):
        return "gemini"
    if setting("OPENAI_API_KEY"):
        return "openai"
    if colab_ai_available():
        return "colab"
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
    label = "Colab built-in (no key)" if p == "colab" else p
    return f"LLM: {label} · model {setting('LLM_MODEL') or cfg['model']}"


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

    from openai import OpenAI  # Gemini, Vocareum and Colab's proxy all speak the OpenAI API
    if p == "colab":
        client = OpenAI(api_key=os.getenv("MODEL_PROXY_API_KEY"),
                        base_url=f"{os.getenv('MODEL_PROXY_HOST')}/models/openapi")
    else:
        client = OpenAI(api_key=setting(cfg["key"]), base_url=cfg["base_url"])
    response = client.chat.completions.create(
        model=model or setting("LLM_MODEL") or cfg["model"],
        messages=messages,
        temperature=temperature,
    )
    return response.choices[0].message.content

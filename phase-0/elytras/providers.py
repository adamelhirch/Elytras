"""Passerelle LLM + providers d'abonnement NATIFS.

- openai / ollama : endpoints OpenAI-compatibles classiques.
- codex / claude / gemini : providers d'abonnement, auth gérée par `provider_auth`
  (réimplémentation de la technique de CLIProxyAPI), inférence vers le vrai backend.

L'app injecte l'instance ProviderAuth via set_auth() ; les providers natifs résolvent
le token (refresh auto) au moment de l'appel.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Callable, Protocol

import httpx


@dataclass
class Completion:
    text: str
    model: str
    provider: str
    prompt_tokens: int = 0
    completion_tokens: int = 0


class Provider(Protocol):
    name: str
    def complete(self, messages: list[dict], model: str | None = None) -> Completion: ...


# ───────────────────────── Providers OpenAI-compatibles ─────────────────────────
class OpenAICompatProvider:
    name = "openai-compat"

    def __init__(self, base_url: str, api_key: str = "", default_model: str = "gpt-5"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.default_model = default_model

    def complete(self, messages: list[dict], model: str | None = None) -> Completion:
        model = model or self.default_model
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        r = httpx.post(f"{self.base_url}/chat/completions", headers=headers, timeout=120,
                       json={"model": model, "messages": messages})
        r.raise_for_status()
        d = r.json()
        u = d.get("usage", {})
        return Completion(text=d["choices"][0]["message"]["content"], model=model, provider=self.name,
                          prompt_tokens=u.get("prompt_tokens", 0), completion_tokens=u.get("completion_tokens", 0))


class OpenAIProvider(OpenAICompatProvider):
    name = "openai"
    def __init__(self, model: str = "gpt-5"):
        super().__init__("https://api.openai.com/v1", os.environ.get("OPENAI_API_KEY", ""), model)


class OllamaProvider(OpenAICompatProvider):
    name = "ollama"
    def __init__(self, model: str = "qwen2.5:3b"):
        host = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
        super().__init__(f"{host}/v1", "ollama", model)


# ───────────────────────── Résolution des tokens d'abonnement ─────────────────────────
_AUTH = None        # instance provider_auth.ProviderAuth (injectée par l'app)
_AUTH_USER = None


def set_auth(auth, user_id):
    global _AUTH, _AUTH_USER
    _AUTH, _AUTH_USER = auth, user_id


def _token(provider: str) -> tuple[str | None, dict]:
    if not _AUTH:
        return None, {}
    at = _AUTH.access_token(provider, _AUTH_USER)
    rec = _AUTH.store.get_tokens(_AUTH_USER, provider) or {}
    return at, rec


# ───────────────────────── Providers d'abonnement natifs ─────────────────────────
# NB inférence : best-effort, à valider avec un vrai compte (endpoints/headers extraits
# de CLIProxyAPI). L'AUTH, elle, est testée. Voir Phase-0.md (avertissement ToS).
class CodexProvider:
    name = "codex"
    def __init__(self, model: str = "gpt-5.4-mini"):
        self.default_model = model

    def complete(self, messages: list[dict], model: str | None = None) -> Completion:
        at, rec = _token("codex")
        if not at:
            raise RuntimeError("Codex non connecté — connecte-le dans la carte Providers.")
        # Modèle Codex configurable via CODEX_MODEL (défaut gpt-5.4-mini).
        model = os.environ.get("CODEX_MODEL", self.default_model)
        # Codex (API Responses) exige toujours des "instructions" (system prompt).
        instr = "\n".join(m["content"] for m in messages if m.get("role") == "system") \
            or os.environ.get("CODEX_INSTRUCTIONS",
                              "Tu es l'assistant d'Elytras. Réponds clairement et de façon concise.")
        inp = [{"role": m["role"],
                "content": [{"type": ("output_text" if m["role"] == "assistant" else "input_text"),
                             "text": m["content"]}]}
               for m in messages if m.get("role") != "system"]
        body = {"model": model, "input": inp, "stream": True, "store": False, "instructions": instr}
        headers = {"Authorization": f"Bearer {at}", "chatgpt-account-id": rec.get("account_id", ""),
                   "Content-Type": "application/json", "Accept": "text/event-stream",
                   "OpenAI-Beta": "responses=experimental", "originator": "codex_cli_rs"}
        out: list[str] = []
        done_text = ""
        with httpx.stream("POST", "https://chatgpt.com/backend-api/codex/responses",
                          headers=headers, json=body, timeout=180) as r:
            if r.status_code >= 400:
                detail = r.read().decode(errors="replace")[:500]
                raise RuntimeError(f"Codex HTTP {r.status_code} — {detail}")
            for line in r.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data in ("", "[DONE]"):
                    continue
                try:
                    ev = json.loads(data)
                except Exception:
                    continue
                t = ev.get("type", "")
                if t == "response.output_text.delta" and ev.get("delta"):
                    out.append(ev["delta"])
                elif t == "response.output_text.done" and ev.get("text"):
                    done_text = ev["text"]
                elif t == "response.completed" and not out and not done_text:
                    done_text = _responses_text(ev.get("response", {}))
        return Completion(text="".join(out) or done_text or "(réponse vide)", model=model, provider="codex")

    def agent_turn(self, input_items: list, instructions: str, tools: list | None = None) -> dict:
        """Un tour Codex AVEC outils. Renvoie {text, tool_calls:[{call_id,name,arguments}]}."""
        at, rec = _token("codex")
        if not at:
            raise RuntimeError("Codex non connecté — connecte-le dans la carte Providers.")
        model = os.environ.get("CODEX_MODEL", self.default_model)
        body = {"model": model, "input": input_items, "instructions": instructions,
                "stream": True, "store": False}
        if tools:
            body["tools"] = tools
        headers = {"Authorization": f"Bearer {at}", "chatgpt-account-id": rec.get("account_id", ""),
                   "Content-Type": "application/json", "Accept": "text/event-stream",
                   "OpenAI-Beta": "responses=experimental", "originator": "codex_cli_rs"}
        text: list[str] = []
        done_text = ""
        fc: dict = {}
        with httpx.stream("POST", "https://chatgpt.com/backend-api/codex/responses",
                          headers=headers, json=body, timeout=180) as r:
            if r.status_code >= 400:
                raise RuntimeError(f"Codex HTTP {r.status_code} — {r.read().decode(errors='replace')[:500]}")
            for line in r.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data in ("", "[DONE]"):
                    continue
                try:
                    ev = json.loads(data)
                except Exception:
                    continue
                t = ev.get("type", "")
                if t == "response.output_text.delta" and ev.get("delta"):
                    text.append(ev["delta"])
                elif t == "response.output_text.done" and ev.get("text"):
                    done_text = ev["text"]
                elif t == "response.output_item.added":
                    it = ev.get("item", {})
                    if it.get("type") == "function_call":
                        fc[it.get("id")] = {"call_id": it.get("call_id"), "name": it.get("name"),
                                            "arguments": it.get("arguments") or ""}
                elif t == "response.function_call_arguments.delta":
                    iid = ev.get("item_id")
                    if iid in fc:
                        fc[iid]["arguments"] += ev.get("delta", "")
                elif t == "response.output_item.done":
                    it = ev.get("item", {})
                    if it.get("type") == "function_call":
                        e = fc.setdefault(it.get("id"), {})
                        if it.get("call_id"):
                            e["call_id"] = it["call_id"]
                        if it.get("name"):
                            e["name"] = it["name"]
                        if it.get("arguments"):
                            e["arguments"] = it["arguments"]
        calls = [c for c in fc.values() if c.get("name") and c.get("call_id")]
        return {"text": "".join(text) or done_text, "tool_calls": calls}


class ClaudeProvider:
    name = "claude"
    def __init__(self, model: str = "claude-sonnet-4-5-20250929"):
        self.default_model = model

    def complete(self, messages: list[dict], model: str | None = None) -> Completion:
        at, _ = _token("claude")
        if not at:
            raise RuntimeError("Claude non connecté — lance le login depuis l'interface.")
        model = model or self.default_model
        system = " ".join(m["content"] for m in messages if m["role"] == "system")
        msgs = [{"role": m["role"], "content": m["content"]} for m in messages if m["role"] != "system"]
        body = {"model": model, "max_tokens": 4096, "messages": msgs}
        if system:
            body["system"] = system
        r = httpx.post("https://api.anthropic.com/v1/messages",
                       headers={"Authorization": f"Bearer {at}", "anthropic-version": "2023-06-01",
                                "anthropic-beta": os.environ.get("ANTHROPIC_BETA", "oauth-2025-04-20"),
                                "Content-Type": "application/json"},
                       json=body, timeout=120)
        r.raise_for_status()
        d = r.json()
        text = "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
        return Completion(text=text, model=model, provider="claude")


def _responses_text(d: dict) -> str:
    parts = []
    for item in d.get("output", []):
        for c in item.get("content", []) if isinstance(item, dict) else []:
            if c.get("type") in ("output_text", "text") and c.get("text"):
                parts.append(c["text"])
    return "".join(parts) or d.get("output_text", "") or ""


# ───────────────────────── Embeddings locaux ─────────────────────────
def embed(text: str) -> list[float]:
    host = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
    model = os.environ.get("EMBED_MODEL", "nomic-embed-text")
    try:
        r = httpx.post(f"{host}/api/embeddings", timeout=60, json={"model": model, "prompt": text})
        r.raise_for_status()
        return r.json()["embedding"]
    except Exception:
        return [0.0] * 768


_COST = {"gpt-5": (1.25, 10.0)}


def estimate_cost(model: str, pt: int, ct: int) -> float:
    pin, pout = _COST.get(model, (0.0, 0.0))
    return round(pt / 1e6 * pin + ct / 1e6 * pout, 5)


_PROVIDERS = {"codex": CodexProvider, "claude": ClaudeProvider,
              "openai": OpenAIProvider, "ollama": OllamaProvider}


class Gateway:
    def __init__(self, log_usage: Callable | None = None):
        self.log_usage = log_usage

    def get(self, provider: str | None = None, model: str | None = None) -> Provider:
        provider = provider or os.environ.get("ELYTRAS_PROVIDER", "codex")
        model = model or os.environ.get("ELYTRAS_MODEL")
        cls = _PROVIDERS.get(provider, OpenAIProvider)
        return cls(model=model) if model else cls()

    def complete(self, messages, provider=None, model=None, user_id=None, tenant_id=None) -> Completion:
        c = self.get(provider, model).complete(messages)
        cost = estimate_cost(c.model, c.prompt_tokens, c.completion_tokens)
        if self.log_usage:
            self.log_usage(c.provider, c.model, c.prompt_tokens, c.completion_tokens, cost, user_id, tenant_id)
        return c

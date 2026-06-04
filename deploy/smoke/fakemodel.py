"""Faux modèle local imitant OpenRouter (/v1/chat/completions) — pour tester SANS clé ni frais."""
from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/chat/completions")
async def chat_completions(body: dict):
    msgs = body.get("messages", [])
    text = "Bonjour, je suis l'agent Elytras de test. Tout fonctionne de bout en bout."
    pt = sum(len(str(m.get("content", ""))) // 4 for m in msgs) + 5
    return {"id": "fake", "object": "chat.completion", "model": body.get("model", "fake"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": pt, "completion_tokens": len(text) // 4}}

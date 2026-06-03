"""Provider passerelle : complétion + traduction agentique Responses <-> chat/completions."""
import elytras.providers as P


def test_gateway_complete(monkeypatch):
    captured = {}

    def fake_post(self, payload):
        captured["payload"] = payload
        return {"choices": [{"message": {"content": "bonjour"}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 3}, "model": "eco"}

    monkeypatch.setattr(P.ElytrasGatewayProvider, "_post", fake_post)
    c = P.ElytrasGatewayProvider(model="eco").complete([{"role": "user", "content": "salut"}])
    assert c.text == "bonjour" and c.prompt_tokens == 12 and c.completion_tokens == 3
    assert captured["payload"]["model"] == "eco"               # gamme envoyée, pas un modèle réel


def test_gateway_agent_turn_translation(monkeypatch):
    captured = {}

    def fake_post(self, payload):
        captured["payload"] = payload
        return {"choices": [{"message": {"content": None, "tool_calls": [
            {"id": "call_1", "type": "function",
             "function": {"name": "run_flow", "arguments": '{"flow":"X"}'}}]}}], "usage": {}}

    monkeypatch.setattr(P.ElytrasGatewayProvider, "_post", fake_post)
    items = [
        {"role": "user", "content": [{"type": "input_text", "text": "lance le flow"}]},
        {"type": "function_call", "call_id": "c0", "name": "prev", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "c0", "output": "ok"},
    ]
    tools = [{"type": "function", "name": "run_flow", "description": "d", "parameters": {"type": "object"}}]
    out = P.ElytrasGatewayProvider(model="standard").agent_turn(items, "tu es un agent", tools)

    assert out["tool_calls"] == [{"call_id": "call_1", "name": "run_flow", "arguments": '{"flow":"X"}'}]
    msgs = captured["payload"]["messages"]
    assert msgs[0] == {"role": "system", "content": "tu es un agent"}
    assert msgs[1] == {"role": "user", "content": "lance le flow"}                 # input_text -> texte
    assert msgs[2]["role"] == "assistant" and msgs[2]["tool_calls"][0]["function"]["name"] == "prev"
    assert msgs[3] == {"role": "tool", "tool_call_id": "c0", "content": "ok"}       # output -> tool msg
    assert captured["payload"]["tools"][0]["function"]["name"] == "run_flow"        # tool format chat

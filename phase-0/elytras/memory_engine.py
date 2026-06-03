"""Moteur de mémoire long terme (inspiré de Mem0), robuste et performant.

Principes :
- EXTRACTION : le LLM transforme un échange en FAITS atomiques durables. Consigne stricte
  (uniquement l'explicite, aucune invention) -> peu d'hallucinations.
- STOCKAGE : faits scopés (user / projet) avec PROVENANCE (session, date) + embedding.
- DÉDUPLICATION / MAJ : un fait très proche d'un existant le met à jour (pas d'accumulation
  ni de contradictions) -> mémoire bornée et cohérente.
- RAPPEL : hybride (similarité sémantique + recouvrement de mots-clés + récence), scopé, top-K
  -> pertinent et performant. Repli récence/mots-clés si les embeddings ne sont pas dispo.
- L'extraction tourne en tâche de fond (voir main) -> la réponse du chat n'est pas ralentie.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
import uuid

from . import filestore, providers

SECTION = "memory"
_DUP_THRESHOLD = 0.90       # au-dessus : on considère que c'est le même fait (mise à jour)
_THRESHOLD = int(os.environ.get("MEM_CONSOLIDATE_THRESHOLD", "40"))   # consolide au-delà de N faits actifs
_BATCH = int(os.environ.get("MEM_CONSOLIDATE_BATCH", "20"))           # nb de faits compressés par passe


def _embed(text: str):
    try:
        v = providers.embed(text or "")
        return v if isinstance(v, list) and any(v) else None    # zéros => Ollama absent
    except Exception:
        return None


def _cos(a, b) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _kw(q: str, text: str) -> int:
    qs = {w for w in re.findall(r"\w+", (q or "").lower()) if len(w) > 2}
    ts = {w for w in re.findall(r"\w+", (text or "").lower()) if len(w) > 2}
    return len(qs & ts)


def _scope_match(e: dict, scope, owner, project) -> bool:
    if e.get("scope_type") != scope:
        return False
    if scope == "user":
        return e.get("owner_id") == owner
    if scope == "project":
        return e.get("project_id") == project
    return True


def _items(scope, owner, project):
    return [(mid, e) for mid, e in filestore.items(SECTION).items() if _scope_match(e, scope, owner, project)]


_EXTRACT_SYS = (
    "Tu es un EXTRACTEUR DE MÉMOIRE. À partir du dernier échange (utilisateur + agent), liste les "
    "FAITS DURABLES utiles à retenir sur le long terme : préférences, décisions, infos sur "
    "l'utilisateur/le projet, tâches accomplies, identifiants/config mentionnés. "
    "RÈGLES STRICTES : n'extrais QUE ce qui est explicitement présent dans l'échange ; n'invente RIEN ; "
    "aucune supposition ni reformulation hasardeuse ; 1 fait = 1 phrase courte et autonome ; "
    "ignore le bavardage et les politesses. "
    "Réponds UNIQUEMENT en JSON valide : {\"facts\": [\"...\"]}  (liste vide si rien de durable)."
)


def extract_facts(user_msg: str, assistant_msg: str, complete_fn) -> list[str]:
    """complete_fn(messages)->str (un LLM). Best-effort ; renvoie une liste de faits."""
    try:
        txt = complete_fn([{"role": "system", "content": _EXTRACT_SYS},
                           {"role": "user", "content": f"UTILISATEUR: {user_msg}\nAGENT: {assistant_msg}"}])
        m = re.search(r"\{.*\}", txt or "", re.S)
        data = json.loads(m.group(0)) if m else {}
        return [f.strip() for f in data.get("facts", []) if isinstance(f, str) and f.strip()][:8]
    except Exception:
        return []


def add_fact(scope, owner, project, content: str, source_ref: str = "") -> str:
    """Ajoute un fait, ou met à jour un fait quasi identique (dédup)."""
    emb = _embed(content)
    if emb:
        for mid, e in _items(scope, owner, project):
            if e.get("archived") or e.get("level", 0) != 0:
                continue
            if _cos(emb, e.get("embedding") or []) >= _DUP_THRESHOLD:
                e.update({"content": content, "embedding": emb, "source_ref": source_ref,
                          "created_at": time.time()})
                filestore.put(SECTION, mid, e)
                return mid
    else:
        for mid, e in _items(scope, owner, project):
            if e.get("archived") or e.get("level", 0) != 0:
                continue
            if e.get("content", "").strip().lower() == content.strip().lower():
                return mid
    mid = str(uuid.uuid4())
    filestore.put(SECTION, mid, {"scope_type": scope, "owner_id": owner, "project_id": project,
                                 "mtype": "fact", "content": content, "embedding": emb,
                                 "source_ref": source_ref, "created_at": time.time(),
                                 "provenance": {"source": source_ref}})
    return mid


def remember(scope, owner, project, user_msg, assistant_msg, session_id, complete_fn) -> list[str]:
    facts = extract_facts(user_msg, assistant_msg, complete_fn)
    src = f"session:{session_id}" if session_id else "chat"
    for f in facts:
        add_fact(scope, owner, project, f, source_ref=src)
    try:
        consolidate(scope, owner, project, complete_fn)   # compresse si trop de faits actifs
    except Exception:
        pass
    return facts


# ───────────────────────── Consolidation (résumés hiérarchiques) ─────────────────────────
_SUMMARY_SYS = (
    "Tu CONSOLIDES une liste de faits mémorisés en un ensemble PLUS COURT de faits durables. "
    "Fusionne les redondances et regroupe ce qui va ensemble, garde l'information importante, "
    "supprime le superflu. RÈGLES : n'invente rien ; n'utilise que ce qui est dans la liste ; "
    "faits courts et autonomes. Réponds UNIQUEMENT en JSON : {\"facts\": [\"...\"]}."
)


def _summarize(facts_text: str, complete_fn) -> list[str]:
    try:
        txt = complete_fn([{"role": "system", "content": _SUMMARY_SYS},
                           {"role": "user", "content": facts_text}])
        m = re.search(r"\{.*\}", txt or "", re.S)
        data = json.loads(m.group(0)) if m else {}
        return [f.strip() for f in data.get("facts", []) if isinstance(f, str) and f.strip()][:10]
    except Exception:
        return []


def consolidate(scope, owner, project, complete_fn) -> int:
    """Si trop de faits actifs : compresse les plus anciens en résumés (niveau 1) qui gardent
    le lien vers les faits sources (récupérables via expand), puis archive les bruts."""
    raw = [(mid, e) for mid, e in _items(scope, owner, project)
           if e.get("level", 0) == 0 and not e.get("archived")]
    if len(raw) <= _THRESHOLD:
        return 0
    raw.sort(key=lambda x: x[1].get("created_at", 0))      # plus anciens d'abord
    batch = raw[:_BATCH]
    summary = _summarize("\n".join("- " + e.get("content", "") for _, e in batch), complete_fn)
    if not summary:
        return 0
    child_ids = [mid for mid, _ in batch]
    srcs = sorted({e.get("source_ref", "") for _, e in batch if e.get("source_ref")})
    for sf in summary:
        filestore.put(SECTION, str(uuid.uuid4()),
                      {"scope_type": scope, "owner_id": owner, "project_id": project,
                       "mtype": "summary", "level": 1, "content": sf, "embedding": _embed(sf),
                       "child_ids": child_ids, "source_refs": srcs, "source_ref": "consolidation",
                       "created_at": time.time(), "provenance": {"children": len(child_ids)}})
    for mid, e in batch:                                    # archive les bruts (récupérables via expand)
        e["archived"] = True
        filestore.put(SECTION, mid, e)
    return len(batch)


def expand(mid: str) -> list[str]:
    """Récupère les faits sources d'un résumé (drill-down lossless)."""
    e = filestore.items(SECTION).get(mid) or {}
    out = []
    for cid in e.get("child_ids", []):
        ce = filestore.items(SECTION).get(cid)
        if ce:
            out.append(ce.get("content", ""))
    return out


def recall(scope, owner, project, query: str = "", k: int = 12) -> list[dict]:
    items = [e for _, e in _items(scope, owner, project) if not e.get("archived")]
    if not items:
        return []
    recent = sorted(items, key=lambda e: e.get("created_at", 0), reverse=True)
    qv = _embed(query) if query else None
    if qv or query:
        ranked = sorted(items, key=lambda e: (_cos(qv, e.get("embedding") or []) if qv else 0)
                        + 0.08 * _kw(query, e.get("content", "")), reverse=True)
    else:
        ranked = recent
    chosen, seen = [], set()
    for e in recent[:4] + ranked:               # garantit le contexte récent + le plus pertinent
        cont = e.get("content", "")
        if not cont or cont in seen:
            continue
        seen.add(cont)
        chosen.append({"content": cont, "source": e.get("source_ref", "")})
        if len(chosen) >= k:
            break
    return chosen


def list_for_user(user_id, member_project_ids, k: int = 200) -> list[dict]:
    """Mémoire visible par un utilisateur : ses faits perso + ceux des projets dont il est membre + global."""
    out = []
    for mid, e in filestore.items(SECTION).items():
        if e.get("archived"):
            continue
        st = e.get("scope_type")
        if (st == "user" and e.get("owner_id") == user_id) \
                or (st == "project" and e.get("project_id") in (member_project_ids or [])) \
                or st == "global":
            out.append({"id": mid, "content": e.get("content", ""), "scope": st,
                        "source": e.get("source_ref", ""), "level": e.get("level", 0),
                        "children": len(e.get("child_ids", [])), "created_at": e.get("created_at", 0)})
    out.sort(key=lambda e: e.get("created_at", 0), reverse=True)
    return out[:k]


def reset_user(user_id):
    """Efface les faits PERSO de l'utilisateur (les mémoires de projet partagées sont conservées)."""
    for mid, e in list(filestore.items(SECTION).items()):
        if e.get("scope_type") == "user" and e.get("owner_id") == user_id:
            filestore.delete(SECTION, mid)

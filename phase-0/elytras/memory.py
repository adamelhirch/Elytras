"""Mémoire scopée anti-hallucination : pgvector + RLS + provenance + résumés lossless.

- La RLS (db/schema.sql) garantit qu'un agent ne lit QUE les scopes de son user mandant.
- `recall` renvoie la PROVENANCE des souvenirs pour que l'agent cite ses sources.
- `summarize_session` pose la couche "lossless" (résumé qui garde le lien vers le brut).
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass

try:
    import psycopg                       # Postgres optionnel : non requis en mode fichier
except Exception:                        # pragma: no cover
    psycopg = None

from . import filestore
from .providers import embed


@dataclass
class MemoryHit:
    id: str
    content: str
    source_ref: str | None
    provenance: dict
    score: float


def _vec(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


class MemoryStore:
    def __init__(self, conn):
        self.conn = conn

    def set_context(self, user_id, tenant_id, role="member", agent_id=None, session_id=None):
        """Pose les variables de session lues par la RLS. À appeler avant tout accès mémoire."""
        with self.conn.cursor() as cur:
            cur.execute("SELECT set_config('app.current_user_id',   %s, false)", (str(user_id),))
            cur.execute("SELECT set_config('app.current_tenant_id', %s, false)", (str(tenant_id),))
            cur.execute("SELECT set_config('app.current_role',      %s, false)", (role,))
            if agent_id:
                cur.execute("SELECT set_config('app.current_agent_id',   %s, false)", (str(agent_id),))
            if session_id:
                cur.execute("SELECT set_config('app.current_session_id', %s, false)", (str(session_id),))
        self.conn.commit()

    def write(self, tenant_id, scope_type, content, *, owner_id=None, project_id=None,
              agent_id=None, session_id=None, mtype="fact", source_ref=None, provenance=None):
        """Écrit un souvenir ANCRÉ. Pour un fait calculé, renseigner source_ref + provenance."""
        emb = _vec(embed(content))
        with self.conn.cursor() as cur:
            cur.execute(
                """INSERT INTO memory (tenant_id, scope_type, owner_id, project_id, agent_id,
                       session_id, mtype, content, embedding, source_ref, provenance)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::vector,%s,%s) RETURNING id""",
                (tenant_id, scope_type, owner_id, project_id, agent_id, session_id,
                 mtype, content, emb, source_ref, json.dumps(provenance or {})),
            )
            mid = cur.fetchone()[0]
        self.conn.commit()
        return mid

    def recall(self, query: str, k: int = 5) -> list[MemoryHit]:
        """Recherche sémantique (la RLS limite déjà aux scopes autorisés)."""
        q = _vec(embed(query))
        with self.conn.cursor() as cur:
            cur.execute(
                """SELECT id, content, source_ref, provenance,
                          1 - (embedding <=> %s::vector) AS score
                   FROM memory
                   WHERE embedding IS NOT NULL
                   ORDER BY embedding <=> %s::vector
                   LIMIT %s""",
                (q, q, k),
            )
            rows = cur.fetchall()
        return [MemoryHit(str(r[0]), r[1], r[2], r[3] or {}, float(r[4])) for r in rows]

    def summarize_session(self, tenant_id, session_id, raw_items: list[str], source_refs: list[str]):
        """Couche 'lossless' : stocke un résumé qui GARDE le lien vers ses sources.
        Squelette : la condensation hiérarchique en DAG (façon Lossless Claw) se branche ici."""
        with self.conn.cursor() as cur:
            cur.execute(
                """INSERT INTO memory_summary (tenant_id, session_id, level, content, source_refs)
                   VALUES (%s,%s,1,%s,%s) RETURNING id""",
                (tenant_id, session_id, "\n".join(raw_items)[:4000], source_refs),
            )
            sid = cur.fetchone()[0]
        self.conn.commit()
        return sid


class FileMemoryStore:
    """Mémoire en mode FICHIER (sans Postgres) : stockage simple + recherche par mots-clés,
    sans embeddings. Suffisant pour le mode local sans Docker. L'isolation forte (RLS)
    n'existe qu'avec Postgres ; ici on garde quand même les scopes en métadonnées."""

    def set_context(self, *a, **k):
        pass

    def write(self, tenant_id, scope_type, content, *, owner_id=None, project_id=None,
              agent_id=None, session_id=None, mtype="fact", source_ref=None, provenance=None):
        mid = str(uuid.uuid4())
        filestore.put("memory", mid, {"scope_type": scope_type, "owner_id": owner_id,
                                      "project_id": project_id, "mtype": mtype, "content": content,
                                      "source_ref": source_ref, "provenance": provenance or {}})
        return mid

    def recall(self, query, k=10):
        ent = list(filestore.items("memory").items())   # (id, entry)
        words = [w for w in (query or "").lower().split() if len(w) > 2]
        match = [(i, e) for (i, e) in ent if any(w in e.get("content", "").lower() for w in words)] if words else ent
        match = (match or ent)[-k:][::-1]
        return [MemoryHit(id=i, content=e.get("content", ""), source_ref=e.get("source_ref"),
                          provenance=e.get("provenance", {}), score=1.0) for (i, e) in match]

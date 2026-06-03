"""Chargeur de skills (format Agent Skills : un dossier + SKILL.md).

Une skill = du SAVOIR-FAIRE packagé (données, pas du code cœur). Elle décrit
quoi faire et quels outils MCP utiliser. On ajoute une skill = on dépose un
dossier, sans toucher au cœur.
"""
from __future__ import annotations

import glob
import os


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    meta: dict = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].strip().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = text[end + 4:].lstrip()
    return meta, body


def load_skills(skills_dir: str | None = None) -> list[dict]:
    skills_dir = skills_dir or os.environ.get("SKILLS_DIR", "skills")
    out = []
    for path in sorted(glob.glob(os.path.join(skills_dir, "*", "SKILL.md"))):
        try:
            meta, body = _parse_frontmatter(open(path, encoding="utf-8").read())
        except Exception:
            continue
        out.append({
            "name": meta.get("name", os.path.basename(os.path.dirname(path))),
            "description": meta.get("description", ""),
            "mcp_tools": [t.strip() for t in meta.get("mcp_tools", "").split(",") if t.strip()],
            "path": path,
        })
    return out


def read_skill(name: str, skills_dir: str | None = None) -> str | None:
    """Renvoie la PROCÉDURE détaillée (corps du SKILL.md) d'une skill, par son nom.
    Sert au chargement progressif : l'agent appelle use_skill(name) au besoin."""
    for s in load_skills(skills_dir):
        if s["name"] == name:
            try:
                _meta, body = _parse_frontmatter(open(s["path"], encoding="utf-8").read())
                return body
            except Exception:
                return ""
    return None

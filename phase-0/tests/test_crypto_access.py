"""Chiffrement des secrets (persistance de clé = critique au déploiement) + contrôle d'accès MCP/skill."""
import importlib
import elytras.crypto as C
import elytras.main as M
import elytras.rbac as R
import elytras.filestore as filestore


def test_encrypt_roundtrip():
    blob = C.encrypt("token-secret-123")
    assert blob != b"token-secret-123" and C.decrypt(blob) == "token-secret-123"


def test_key_generated_and_persisted(tmp_path, monkeypatch):
    """Sans clé forte fournie : une clé est générée au 1er lancement et RELUE ensuite
    (un secret chiffré avant 'redémarrage' reste déchiffrable après)."""
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "test")           # faible → ignorée
    monkeypatch.setenv("ELYTRAS_KEY_FILE", str(tmp_path / ".elytras-key"))
    k1 = C._key_material()
    assert (tmp_path / ".elytras-key").exists()
    assert oct((tmp_path / ".elytras-key").stat().st_mode)[-3:] == "600"
    blob = C.encrypt("api-key")
    assert C._key_material() == k1                              # relue, pas régénérée
    assert C.decrypt(blob) == "api-key"                        # survit au 'redémarrage'


def test_strong_env_key_takes_precedence(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "une-cle-forte-et-bien-longue-2026")
    monkeypatch.setenv("ELYTRAS_KEY_FILE", str(tmp_path / ".elytras-key"))
    assert C._key_material() == b"une-cle-forte-et-bien-longue-2026"
    assert not (tmp_path / ".elytras-key").exists()            # aucun fichier généré


def test_mcp_access_per_team(client, admin, H):
    tA = admin.mkteam("EquipeA", "operateur")
    tB = admin.mkteam("EquipeB", "operateur")
    admin.mkuser("A", "a@x.com", "p", [tA])
    admin.mkuser("B", "b@x.com", "p", [tB])
    uidA, _ = R.find_by_email("a@x.com")
    uidB, _ = R.find_by_email("b@x.com")
    adm, _ = R.find_by_email("admin@x.com")
    srv = {"id": "s1", "allow_all": False, "allowed_teams": [tA]}     # réservé à l'équipe A
    assert M._can_use_server(uidA, srv) is True
    assert M._can_use_server(uidB, srv) is False
    assert M._can_use_server(adm, srv) is True                       # admin passe partout
    assert M._can_use_server(uidB, {"allow_all": True, "allowed_teams": []}) is True


def test_skill_access_default_open_then_restricted(client, admin, H):
    t = admin.mkteam("Comm", "operateur")
    admin.mkuser("Z", "z@x.com", "p", [t])
    uidZ, _ = R.find_by_email("z@x.com")
    assert M._can_use_skill(uidZ, "pptx") is True                    # défaut : ouvert
    filestore.put("skill_access", "pptx", {"allow_all": False, "allowed_teams": ["autre-equipe"]})
    assert M._can_use_skill(uidZ, "pptx") is False                   # restreint → bloqué


def test_sandbox_cmd_isolation(monkeypatch):
    """Le bac à sable Linux (bwrap) coupe le réseau et monte le FS en lecture seule ;
    seul le dossier de travail est accessible en écriture."""
    monkeypatch.setattr(M, "_SANDBOX_MODE", "auto")
    monkeypatch.setattr(M.sys, "platform", "linux")
    monkeypatch.setattr(M.shutil, "which", lambda n: "/usr/bin/bwrap" if n == "bwrap" else None)
    cmd, sb = M._sandbox_cmd(["python3", "/x/s.py"], "/x/s.py", work="/work")
    assert sb is True
    assert "--unshare-net" in cmd and "--die-with-parent" in cmd       # réseau coupé
    assert cmd[cmd.index("--ro-bind") + 1:cmd.index("--ro-bind") + 3] == ["/", "/"]  # FS read-only
    assert cmd[cmd.index("--bind") + 1:cmd.index("--bind") + 3] == ["/work", "/work"]  # work en écriture


def test_sandbox_required_mode_raises_without_tool(monkeypatch):
    """ELYTRAS_CODE_SANDBOX=on : refuse d'exécuter si aucun bac à sable n'est disponible."""
    monkeypatch.setattr(M, "_SANDBOX_MODE", "on")
    monkeypatch.setattr(M.shutil, "which", lambda n: None)
    try:
        M._sandbox_cmd(["python3", "/x/s.py"], "/x/s.py")
        assert False, "aurait dû lever"
    except RuntimeError as e:
        assert "bac à sable" in str(e)

"""Sauvegarde/restauration : le cycle complet backup → destruction → restore est prouvé.

Mode « sans Docker » (ELYTRAS_DATA_DIR/GATEWAY_DATA_DIR) — la même logique tar/openssl
sert en prod sur les volumes Docker.
"""
import json
import pathlib
import subprocess

DEPLOY = pathlib.Path(__file__).resolve().parents[1]


def run(script, *args, env=None, expect=0):
    e = {"PATH": "/usr/bin:/bin:/usr/local/bin", **(env or {})}
    r = subprocess.run(["bash", str(DEPLOY / script), *args],
                       capture_output=True, text=True, env=e, cwd=DEPLOY)
    assert r.returncode == expect, f"{script} rc={r.returncode}\n{r.stdout}\n{r.stderr}"
    return r


def fake_instance(tmp_path):
    """Fabrique un état d'instance réaliste : état JSON + clé + fichiers uploadés."""
    data = tmp_path / "data"
    (data / "files_data").mkdir(parents=True)
    (data / ".elytras-state.json").write_text(json.dumps({"users": [{"name": "Léo"}]}))
    (data / ".elytras-key").write_bytes(b"k" * 44)
    (data / "files_data" / "facture-001.pdf").write_bytes(b"%PDF fake " * 100)
    return data


def env_for(data, backups, gateway=None):
    e = {"BACKUP_PASSPHRASE": "phrase-de-test-très-forte",
         "BACKUP_DIR": str(backups), "ELYTRAS_DATA_DIR": str(data)}
    if gateway:
        e["GATEWAY_DATA_DIR"] = str(gateway)
    return e


def test_backup_then_wipe_then_restore(tmp_path):
    data, backups = fake_instance(tmp_path), tmp_path / "backups"
    gw = tmp_path / "gw"
    gw.mkdir()
    (gw / ".gateway-state.json").write_text('{"tenants": [{"name": "Vanille Désire"}]}')
    env = env_for(data, backups, gw)

    out = run("backup.sh", env=env).stdout
    assert "vérifiée" in out                                        # auto-vérification passée
    archive = next(backups.glob("elytras-backup-*.tar.gz.enc"))
    assert (backups / (archive.name + ".sha256")).exists()          # empreinte présente

    # destruction totale (le serveur a brûlé)
    for p in sorted(data.rglob("*"), reverse=True):
        p.unlink() if p.is_file() else p.rmdir()
    (gw / ".gateway-state.json").unlink()

    run("restore.sh", str(archive), "--yes", env=env)
    state = json.loads((data / ".elytras-state.json").read_text())
    assert state["users"][0]["name"] == "Léo"                       # état restauré à l'identique
    assert (data / ".elytras-key").read_bytes() == b"k" * 44        # clé de chiffrement intacte
    assert (data / "files_data" / "facture-001.pdf").stat().st_size > 0
    assert "Vanille Désire" in (gw / ".gateway-state.json").read_text()


def test_archive_is_actually_encrypted(tmp_path):
    data, backups = fake_instance(tmp_path), tmp_path / "backups"
    run("backup.sh", env=env_for(data, backups))
    blob = next(backups.glob("*.enc")).read_bytes()
    assert blob[:8] == b"Salted__"                                  # format openssl, pas un tar nu
    assert "Léo".encode() not in blob and b"elytras-state" not in blob   # aucun contenu en clair


def test_wrong_passphrase_fails(tmp_path):
    data, backups = fake_instance(tmp_path), tmp_path / "backups"
    run("backup.sh", env=env_for(data, backups))
    archive = next(backups.glob("*.enc"))
    bad = {**env_for(data, backups), "BACKUP_PASSPHRASE": "mauvaise-phrase"}
    run("restore.sh", str(archive), "--yes", env=bad, expect=1)     # refuse, n'écrase rien
    run("backup.sh", "--verify", str(archive), env=bad, expect=1)


def test_verify_and_rotation(tmp_path):
    data, backups = fake_instance(tmp_path), tmp_path / "backups"
    env = {**env_for(data, backups), "BACKUP_KEEP": "2"}
    for _ in range(3):
        run("backup.sh", env=env)
    archives = sorted(backups.glob("*.enc"))
    assert len(archives) == 2                                       # rotation : 3 créées, 2 gardées
    run("backup.sh", "--verify", str(archives[-1]), env=env)


def test_missing_passphrase_refuses(tmp_path):
    data = fake_instance(tmp_path)
    r = run("backup.sh", env={"ELYTRAS_DATA_DIR": str(data)}, expect=1)
    assert "BACKUP_PASSPHRASE" in r.stdout + r.stderr               # message clair, pas de dump non chiffré

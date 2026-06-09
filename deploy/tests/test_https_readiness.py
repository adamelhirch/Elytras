"""Prêt pour HTTPS : PUBLIC_BASE_URL câblé par l'onboarding + proxy TLS du banc fonctionnel.

(Le parcours complet derrière TLS se joue avec deploy/smoke/run-https.sh.)
"""
import http.server
import json
import pathlib
import ssl
import subprocess
import sys
import threading
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))         # deploy/
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "smoke"))
import onboard      # noqa: E402
import tlsproxy     # noqa: E402


# --- 1. l'onboarding définit l'URL publique (bug réel : OAuth/webhooks pointaient localhost) ---

def test_domain_sets_public_base_url_https():
    env, _, _ = onboard.build_config({"company": "X", "ai_mode": "test",
                                      "domain": "garage.elytras.app"})
    assert env["PUBLIC_BASE_URL"] == "https://garage.elytras.app"   # callbacks OAuth/SSO/webhooks corrects


def test_no_domain_falls_back_to_local_http():
    env, _, _ = onboard.build_config({"company": "X", "ai_mode": "test"})
    assert env["PUBLIC_BASE_URL"] == "http://localhost"
    assert env["ELYTRAS_SITE_ADDRESS"] == ":80"


def test_env_file_contains_public_base_url(tmp_path):
    onboard.write({"company": "X", "ai_mode": "test", "domain": "vd.elytras.app"}, deploy_dir=tmp_path)
    assert "PUBLIC_BASE_URL=https://vd.elytras.app" in (tmp_path / ".env").read_text()


# --- 2. le proxy TLS du banc relaie fidèlement (rôle de Caddy dans run-https.sh) -------------

class Echo(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        out = json.dumps({"path": self.path, "body": body.decode(),
                          "proto": self.headers.get("X-Forwarded-Proto"),
                          "token": self.headers.get("X-Elytras-Token")}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


def test_tlsproxy_relays_post_with_forwarded_headers(tmp_path):
    cert, key = tmp_path / "c.pem", tmp_path / "k.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", str(key),
                    "-out", str(cert), "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"],
                   check=True, capture_output=True)

    up = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    px = tlsproxy.serve(0, f"127.0.0.1:{up.server_address[1]}", str(cert), str(key))
    threading.Thread(target=px.serve_forever, daemon=True).start()

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE          # cert auto-signé : OK pour le banc
    req = urllib.request.Request(f"https://127.0.0.1:{px.server_address[1]}/auth/setup",
                                 data=b'{"name":"Leo"}', method="POST",
                                 headers={"X-Elytras-Token": "tok-123"})
    got = json.loads(urllib.request.urlopen(req, context=ctx, timeout=10).read())
    up.shutdown(), px.shutdown()

    assert got["path"] == "/auth/setup" and got["body"] == '{"name":"Leo"}'   # relai fidèle
    assert got["proto"] == "https"                                            # X-Forwarded-Proto posé
    assert got["token"] == "tok-123"                                          # le header d'auth traverse

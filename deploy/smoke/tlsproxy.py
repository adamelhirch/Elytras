"""Mini reverse proxy TLS (stdlib uniquement) — simule Caddy pour le banc e2e HTTPS.

Termine le TLS (certificat auto-signé) et relaie vers l'app en HTTP, en ajoutant les
en-têtes X-Forwarded-* comme un vrai reverse proxy. Sert UNIQUEMENT aux tests.

    python3 tlsproxy.py --listen 8443 --upstream 127.0.0.1:8000 --cert c.pem --key k.pem
"""
import argparse
import http.client
import http.server
import ssl
import threading

HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
       "proxy-authenticate", "proxy-authorization"}


def make_handler(upstream: str):
    class Proxy(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _relay(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            conn = http.client.HTTPConnection(upstream, timeout=60)
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
            headers["X-Forwarded-Proto"] = "https"               # comme Caddy
            headers["X-Forwarded-For"] = self.client_address[0]
            headers["Host"] = self.headers.get("Host", upstream)
            conn.request(self.command, self.path, body=body, headers=headers)
            r = conn.getresponse()
            data = r.read()
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in HOP and k.lower() != "content-length":
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            conn.close()

        def log_message(self, *a):  # silencieux
            pass

    for m in ("GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"):
        setattr(Proxy, "do_" + m, Proxy._relay)
    return Proxy


def serve(listen_port: int, upstream: str, cert: str, key: str):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", listen_port), make_handler(upstream))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    return srv


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", type=int, default=8443)
    ap.add_argument("--upstream", default="127.0.0.1:8000")
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    a = ap.parse_args()
    s = serve(a.listen, a.upstream, a.cert, a.key)
    print(f"proxy TLS : https://127.0.0.1:{a.listen} -> http://{a.upstream}")
    threading.Thread(target=s.serve_forever, daemon=True).start()
    threading.Event().wait()

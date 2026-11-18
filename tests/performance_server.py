"""Local-only deterministic browser regression/animation harness.

Run: python tests/performance_server.py
Open: http://127.0.0.1:8010/current/
Optional before snapshot: tmp/performance/baseline/static/{index.html,app.js,style.css}
No API keys, production endpoints or third-party API requests are used.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import json

ROOT = Path(__file__).resolve().parents[1]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/harness.js":
            file = ROOT / "tests/browser-performance.js"
        elif path == "/catalog-harness.js":
            file = ROOT / "tests/browser-catalog.js"
        elif path in ("/current/", "/baseline/"):
            base = ROOT if path == "/current/" else ROOT / "tmp/performance/baseline"
            html = (base / "static/index.html").read_text(encoding="utf-8")
            html = html.replace('/static/', path + 'static/')
            harness = '/catalog-harness.js' if parse_qs(urlparse(self.path).query).get('suite') == ['catalog'] else '/harness.js'
            html = html.replace('<!-- App Script -->', f'<script src="{harness}" defer></script><!-- App Script -->')
            return self.send_data(html.encode(), "text/html; charset=utf-8")
        elif path.startswith(("/current/static/", "/baseline/static/")):
            variant, _, name = path.strip("/").split("/", 2)
            if name not in ("app.js", "style.css"):
                return self.send_error(404)
            base = ROOT if variant == "current" else ROOT / "tmp/performance/baseline"
            file = base / "static" / name
            if name == "app.js":
                source = file.read_text(encoding="utf-8")
                source = source.replace('// Wait for DOM + scripts',
                    'window.__cineflowTest = { STATE, DOM, ColdStartFlow, HomeRenderer, OnboardingController, ViewManager };\n    // Wait for DOM + scripts')
                return self.send_data(source.encode(), "text/javascript; charset=utf-8")
        else:
            return self.send_error(404)
        if not file.is_file():
            return self.send_error(404)
        mime = "text/css" if file.suffix == ".css" else "text/javascript"
        self.send_data(file.read_bytes(), mime + "; charset=utf-8")

    def do_POST(self):
        if urlparse(self.path).path != "/results":
            return self.send_error(404)
        size = int(self.headers.get("Content-Length", "0"))
        if size > 100_000:
            return self.send_error(413)
        result = json.loads(self.rfile.read(size))
        name = "baseline" if result.get("variant") == "baseline" else "current"
        mode = "mobile" if result.get("width", 1200) <= 768 else "desktop"
        dest = ROOT / "tmp/performance"
        dest.mkdir(parents=True, exist_ok=True)
        prefix = 'catalog-' if result.get('suite') == 'catalog' else ''
        (dest / f"{prefix}{name}-{mode}-results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        self.send_data(b"ok", "text/plain")

    def send_data(self, data, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("CineFlow test harness: http://127.0.0.1:8010/current/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8010), Handler).serve_forever()

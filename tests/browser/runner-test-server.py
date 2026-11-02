#!/usr/bin/env python3
import hashlib
import json
import mimetypes
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

APP_PORT = 19682
RUNNER_PORT = 19683
APP_DIST = Path(os.environ['BRF_APP_DIST']).resolve()
RUNNER_DIST = Path(os.environ['BRF_RUNNER_DIST']).resolve()
REQUEST_LOG = Path(os.environ['BRF_REQUEST_LOG']).resolve()

APP_CSP = ("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; "
           "frame-src 'self' http://127.0.0.1:19683; connect-src 'self'; img-src 'self' data: blob:; "
           "style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; "
           "object-src 'none'; form-action 'none'")
RUNNER_CSP = ("default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; "
              "frame-ancestors http://127.0.0.1:19682; base-uri 'none'; object-src 'none'; form-action 'none'")
WORKER_CSP = ("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'; "
              "connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'")

class Handler(BaseHTTPRequestHandler):
    def _serve(self, include_body=True):
        port = self.server.server_port
        route = unquote(urlsplit(self.path).path)
        if port == APP_PORT:
            root = APP_DIST
            relative = 'index.html' if route == '/' else route.lstrip('/')
            csp = APP_CSP
        elif port == RUNNER_PORT:
            root = RUNNER_DIST
            if route in ('/frame', '/frame/'):
                body=b'<!doctype html><meta charset="utf-8"><script type="module" src="/frame.js"></script>'
                self._reply(body, 'text/html', RUNNER_CSP, include_body, route)
                return
            relative = route.lstrip('/')
            csp = WORKER_CSP if relative == 'runner.js' else RUNNER_CSP
        else:
            self.send_error(404)
            return
        path = (root / relative).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            self.send_error(404)
            return
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        mime = 'application/wasm' if path.suffix == '.wasm' else (mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        if path.suffix in ('.js', '.mjs', '.ts'):
            mime = 'text/javascript'
        self._reply(data, mime, csp, include_body, route)

    def _reply(self, data, mime, csp, include_body, route):
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Content-Security-Policy', csp)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if include_body:
            self.wfile.write(data)
        record = {'port':self.server.server_port, 'path':route, 'status':200,
                  'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest(), 'csp':csp}
        with REQUEST_LOG.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(record, separators=(',',':')) + '\n')

    def do_GET(self):
        self._serve(True)

    def do_HEAD(self):
        self._serve(False)

    def log_message(self, *_):
        pass

def main():
    REQUEST_LOG.parent.mkdir(parents=True, exist_ok=True)
    servers = [
        ThreadingHTTPServer(('127.0.0.1', APP_PORT), Handler),
        ThreadingHTTPServer(('127.0.0.1', RUNNER_PORT), Handler)
    ]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print(json.dumps({'ready':True,'appPort':APP_PORT,'runnerPort':RUNNER_PORT}), flush=True)
    try:
        threading.Event().wait()
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()

if __name__ == '__main__':
    main()
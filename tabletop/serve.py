#!/usr/bin/env python3
"""Robust static file server for GLB Chess.
Threaded + tolerant of the browser cancelling requests on refresh (Ctrl+F5),
which is what makes the plain `python -m http.server` appear to die.
Usage:  python serve.py [port]      (default 8792)
"""
import os, sys, socketserver, http.server

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    # keep the console quiet
    def log_message(self, *args):
        pass
    # never let the browser serve a stale cached copy (old index/config/models)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()
    # a refresh aborts in-flight downloads -> swallow those instead of crashing
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionError, ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True
    def copyfile(self, source, outputfile):
        try:
            super().copyfile(source, outputfile)
        except (ConnectionError, ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass

# serve some types explicitly (older Pythons guess octet-stream, which is fine for fetch)
Handler.extensions_map.setdefault('.glb', 'model/gltf-binary')
Handler.extensions_map.setdefault('.mjs', 'text/javascript')
Handler.extensions_map.setdefault('.js', 'text/javascript')
Handler.extensions_map.setdefault('.webmanifest', 'application/manifest+json')

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

try:
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"GLB Chess serving at  http://localhost:{PORT}/index.html")
        print("(Leave this window open. Close it to stop.)")
        httpd.serve_forever()
except OSError as e:
    print(f"Could not start server on port {PORT}: {e}")
    print("Another server may already be running on that port — that's fine, just open the URL above.")
    input("Press Enter to close...")

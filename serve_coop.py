#!/usr/bin/env python3
"""Simple HTTP server with COOP/COEP headers for SharedArrayBuffer."""
import http.server
import mimetypes
import sys
import os

# Ensure .js and .wasm have correct MIME types (Python 3.9 may lack them).
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('application/json', '.json')

class COOPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
directory = sys.argv[2] if len(sys.argv) > 2 else '.'
os.chdir(directory)
print(f"Serving {directory} on port {port} with COOP/COEP headers")
http.server.ThreadingHTTPServer(('', port), COOPHandler).serve_forever()

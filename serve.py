#!/usr/bin/env python3
"""Serve Shot Clock locally.

  python3 serve.py            -> http://localhost:8000  (camera works on this machine)
  python3 serve.py --https    -> https://<your-LAN-IP>:8443 for a phone on the same Wi-Fi.
                                 Browsers only allow camera access over HTTPS (or localhost),
                                 so this makes a self-signed certificate in .cert/ — accept the
                                 warning on the phone once.
"""
import argparse
import functools
import http.server
import os
import socket
import ssl
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def ensure_cert(ip):
    d = os.path.join(ROOT, '.cert')
    os.makedirs(d, exist_ok=True)
    cert, key = os.path.join(d, 'cert.pem'), os.path.join(d, 'key.pem')
    if not (os.path.exists(cert) and os.path.exists(key)):
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
            '-keyout', key, '-out', cert, '-subj', '/CN=shot-clock.local',
            '-addext', f'subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost',
        ], check=True, capture_output=True)
    return cert, key


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--https', action='store_true')
    ap.add_argument('--port', type=int)
    args = ap.parse_args()
    handler = functools.partial(Handler, directory=ROOT)
    if args.https:
        ip = lan_ip()
        port = args.port or 8443
        httpd = http.server.ThreadingHTTPServer(('0.0.0.0', port), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*ensure_cert(ip))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        print(f'Shot Clock: https://{ip}:{port}  (open on your phone, accept the certificate warning)')
    else:
        port = args.port or 8000
        httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
        print(f'Shot Clock: http://localhost:{port}')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()

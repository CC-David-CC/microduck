#!/usr/bin/env python3
"""Serve one checked runner build on loopback for an isolated desktop preview.

This small test server is not an Internet-facing production service. For a
real desktop, an operator must serve the same assets and policies from a
separate HTTPS origin and configure the desktop's frame policy accordingly.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

MIME = {'frame':'text/html; charset=utf-8','frame.js':'text/javascript; charset=utf-8',
        'runner.js':'text/javascript; charset=utf-8','microduck-policy.onnx':'application/octet-stream',
        'microduck-runtime.wasm':'application/wasm','runner.js.LEGAL.txt':'text/plain; charset=utf-8'}

def canonical_app_origin(value):
 if not isinstance(value,str) or not value or len(value)>256:raise ValueError('Invalid app origin')
 try:
  parsed=urlsplit(value);port=parsed.port
 except ValueError as error:raise ValueError('Invalid app origin') from error
 if parsed.username is not None or parsed.password is not None or parsed.path or parsed.query or parsed.fragment or not parsed.hostname:raise ValueError('Invalid app origin')
 host=parsed.hostname
 if not re.fullmatch(r'[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*',host):raise ValueError('Invalid app origin')
 if parsed.scheme=='https':
  if port==443:raise ValueError('Default port must be omitted')
 elif parsed.scheme=='http':
  if host not in ('127.0.0.1','localhost') or port is None:raise ValueError('HTTP requires an explicit loopback port')
 else:raise ValueError('HTTPS or loopback HTTP required')
 if port is not None and not 1<=port<=65535:raise ValueError('Invalid port')
 if value!=parsed.scheme+'://'+host+(':'+str(port) if port is not None else ''):raise ValueError('Origin must be canonical')
 return value

def make_server(directory,app_origin,port):
 origin=canonical_app_origin(app_origin);root=Path(directory)
 if root.is_symlink() or not root.is_dir():raise ValueError('Invalid runner directory')
 manifest_path=root/'runner-manifest.json'
 if manifest_path.is_symlink() or not manifest_path.is_file():raise ValueError('Runner manifest missing')
 try: manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
 except (ValueError,OSError) as error:raise ValueError('Invalid runner manifest') from error
 if not isinstance(manifest,dict) or set(manifest)!={'version','appOrigin','files'} or manifest['version']!='microduck-runner/1' or manifest['appOrigin']!=origin:raise ValueError('Runner build origin mismatch')
 files=manifest['files']
 if not isinstance(files,dict) or set(files)!=set(MIME):raise ValueError('Invalid runner inventory')
 contents={}
 for name in MIME:
  path=root/name;expected=files[name]
  if path.is_symlink() or not path.is_file() or not isinstance(expected,str) or not re.fullmatch('[0-9a-f]{64}',expected):raise ValueError('Invalid runner asset: '+name)
  content=path.read_bytes()
  if hashlib.sha256(content).hexdigest()!=expected:raise ValueError('Runner asset hash mismatch: '+name)
  contents[name]=content
 frame_csp=("default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; "
            "frame-ancestors "+origin+"; base-uri 'none'; object-src 'none'; form-action 'none'")
 worker_csp=("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'; "
             "connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'")
 class Handler(BaseHTTPRequestHandler):
  def reply(self,body=True):
   name=self.path[1:] if self.path.startswith('/') else ''
   if re.fullmatch(r'frame\?challenge=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',name):name='frame'
   if name not in contents:self.send_error(404);return
   data=contents[name];self.send_response(200)
   for key,value in {'Content-Type':MIME[name],'Content-Length':str(len(data)),
       'Content-Security-Policy':worker_csp if name=='runner.js' else frame_csp,
       'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'}.items():self.send_header(key,value)
   self.end_headers()
   if body:self.wfile.write(data)
  def do_GET(self):self.reply()
  def do_HEAD(self):self.reply(False)
  def log_message(self,*args):pass
 return ThreadingHTTPServer(('127.0.0.1',port),Handler)

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--directory',required=True,type=Path);p.add_argument('--app-origin',required=True);p.add_argument('--port',required=True,type=int)
 a=p.parse_args()
 if not 1<=a.port<=65535:p.error('Port must be 1..65535')
 try:
  with make_server(a.directory,a.app_origin,a.port) as server:
   print(json.dumps({'ready':True,'origin':f'http://127.0.0.1:{a.port}','appOrigin':a.app_origin}),flush=True)
   try:server.serve_forever()
   except KeyboardInterrupt:pass
 except (ValueError,OSError) as error:p.error(str(error))
if __name__=='__main__':main()

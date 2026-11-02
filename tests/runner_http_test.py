"""Local isolated runner HTTP contract; no desktop identity state is served."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

MODULE = Path(__file__).resolve().parents[1] / 'tools' / 'serve-local-runner.py'
spec = importlib.util.spec_from_file_location('microduck_local_runner', MODULE)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class RunnerHTTPTest(unittest.TestCase):
 def setUp(self):
  self.tmp = tempfile.TemporaryDirectory()
  self.root = Path(self.tmp.name)
  self.files = {'frame':b'<!doctype html>', 'frame.js':b'export {}', 'runner.js':b'export {}', 'microduck-policy.onnx':b'policy', 'microduck-runtime.wasm':b'wasm', 'runner.js.LEGAL.txt':b'license'}
  for name, content in self.files.items(): (self.root/name).write_bytes(content)
  self.manifest = {'version':'microduck-runner/1','appOrigin':'http://127.0.0.1:19682','files':{name:hashlib.sha256(content).hexdigest() for name,content in self.files.items()}}
  (self.root/'runner-manifest.json').write_text(json.dumps(self.manifest))
  self.server = None
 def tearDown(self):
  if self.server:
   self.server.shutdown();self.server.server_close();self.thread.join()
  self.tmp.cleanup()
 def start(self):
  self.server=runner.make_server(self.root,'http://127.0.0.1:19682',0)
  self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
  return 'http://127.0.0.1:'+str(self.server.server_port)
 def request(self,path,method='GET'):
  try:return urllib.request.urlopen(urllib.request.Request(self.base+path,method=method),timeout=3)
  except urllib.error.HTTPError as e:return e
 def test_distinct_policies_and_allowlisted_files(self):
  self.base=self.start()
  for name,expected in self.files.items():
   with self.request('/'+name) as r:
    self.assertEqual(r.status,200);self.assertEqual(r.read(),expected)
    self.assertEqual(r.headers['X-Content-Type-Options'],'nosniff')
    self.assertEqual(r.headers['Cache-Control'],'no-store')
    self.assertNotIn('Set-Cookie',r.headers)
    csp=r.headers['Content-Security-Policy']
    if name=='runner.js':self.assertIn("script-src 'self' 'wasm-unsafe-eval'",csp);self.assertIn("worker-src 'none'",csp)
    else:self.assertIn('frame-ancestors http://127.0.0.1:19682',csp)
  with self.request('/frame?challenge=31222b34-d6a7-42aa-95d4-3d44954d303c') as r:
   self.assertEqual(r.status,200);self.assertEqual(r.read(),self.files['frame'])
  with self.request('/microduck-runtime.wasm',method='HEAD') as r:
   self.assertEqual(r.status,200);self.assertEqual(r.read(),b'');self.assertEqual(r.headers['Content-Type'],'application/wasm')
  for path in ['/runner-manifest.json','/missing','/../frame','/frame?x=1']:
   with self.request(path) as r:self.assertEqual(r.status,404,path)
 def test_rejects_wrong_origin_tampering_and_symlinks(self):
  with self.assertRaises(ValueError):runner.make_server(self.root,'https://different.example',0)
  (self.root/'runner.js').write_bytes(b'tampered')
  with self.assertRaises(ValueError):runner.make_server(self.root,self.manifest['appOrigin'],0)
  (self.root/'runner.js').unlink();(self.root/'runner.js').symlink_to(self.root/'frame.js')
  with self.assertRaises(ValueError):runner.make_server(self.root,self.manifest['appOrigin'],0)
 def test_rejects_noncanonical_origins(self):
  for origin in ['https://EXAMPLE.COM','https://example.com/','https://user@example.com','https://example.com:443','https://example.com?q=1','http://example.com','http://127.0.0.1','https://example.com;script-src']:
   with self.subTest(origin=origin):
    with self.assertRaises(ValueError):runner.canonical_app_origin(origin)
  self.assertEqual(runner.canonical_app_origin('https://desktop.example'), 'https://desktop.example')

if __name__=='__main__':unittest.main()

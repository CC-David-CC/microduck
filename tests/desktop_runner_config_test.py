"""Trusted issuer metadata and desktop frame policy for the Microduck runner."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[4]
ACTIVE=ROOT/'active-system'
spec=importlib.util.spec_from_file_location('microduck_config',ACTIVE/'origin_service/microduck_config.py')
config=importlib.util.module_from_spec(spec);spec.loader.exec_module(config)

class RunnerConfigTest(unittest.TestCase):
 def test_unconfigured_is_absent(self):
  self.assertIsNone(config.runner_origin(None,'https://desktop.example'))
 def test_requires_canonical_distinct_https_origin(self):
  for value in ('http://runner.example','https://desktop.example','https://USER@runner.example','https://RUNNER.example','https://runner.example/','https://runner.example:443','https://runner.example;script-src','https://runner.example?q=1','https://runner.example:0','https://127.1','https://127.0.0.01'):
   with self.subTest(value=value),self.assertRaises(ValueError):config.runner_origin(value,'https://desktop.example')
  self.assertEqual(config.runner_origin('https://runner.example','https://desktop.example'),'https://runner.example')
 def test_loopback_requires_explicit_test_grant_and_distinct_port(self):
  with self.assertRaises(ValueError):config.runner_origin('http://127.0.0.1:19683','http://127.0.0.1:19682')
  self.assertEqual(config.runner_origin('http://127.0.0.1:19683','http://127.0.0.1:19682',allow_loopback=True),'http://127.0.0.1:19683')
  with self.assertRaises(ValueError):config.runner_origin('http://127.0.0.1:19682','http://127.0.0.1:19682',allow_loopback=True)
  self.assertEqual(config.runner_origin('https://runner.example','http://localhost:19682'),'https://runner.example')
 def test_frame_policy_preserves_existing_effective_sources_and_rejects_ambiguity(self):
  r='https://runner.example'
  self.assertEqual(config.frame_policy("default-src 'none'; script-src 'self'",r),"default-src 'none'; script-src 'self'; frame-src https://runner.example")
  self.assertEqual(config.frame_policy("default-src 'self' blob:; script-src 'self'",r),"default-src 'self' blob:; script-src 'self'; frame-src 'self' blob: https://runner.example")
  self.assertEqual(config.frame_policy("default-src 'none'; frame-src 'self' blob:",r),"default-src 'none'; frame-src 'self' blob: https://runner.example")
  self.assertEqual(config.frame_policy("default-src 'none'; frame-src 'none'",r),"default-src 'none'; frame-src https://runner.example")
  self.assertEqual(config.frame_policy("default-src 'none'; frame-src https://runner.example",r),"default-src 'none'; frame-src https://runner.example")
  for csp in ('',"script-src 'self'","default-src 'none'; frame-src 'self'; frame-src blob:","default-src 'none'; frame-src 'none' 'self'"):
   with self.subTest(csp=csp),self.assertRaises(ValueError):config.frame_policy(csp,r)
 def test_document_middleware_is_mount_scoped_and_refuses_duplicate_policies(self):
  headers=[('Content-Security-Policy',"default-src 'self'"),('X-Test','untouched')]
  def app(env,start):start('200 OK',list(headers));return [b'data']
  wrapper=config.RunnerFramePolicy(app,'https://runner.example','/hidden')
  def read(path):
   seen=[]
   def start(status,values,exc=None):seen.extend(values)
   self.assertEqual(wrapper({'PATH_INFO':path},start),[b'data']);return dict(seen)
  self.assertEqual(read('/hidden/')['Content-Security-Policy'],"default-src 'self'; frame-src 'self' https://runner.example")
  self.assertEqual(read('/hidden/index.html')['X-Test'],'untouched')
  self.assertEqual(read('/hidden/assets/worker.js')['Content-Security-Policy'],"default-src 'self'")
  self.assertEqual(read('/')['Content-Security-Policy'],"default-src 'self'")
  headers.append(('content-security-policy',"default-src 'none'"))
  with self.assertRaises(ValueError):read('/hidden/')
 def test_older_release_without_optional_module_still_starts_by_default(self):
  bundle=os.environ.get('MICRODUCK_APP_BUNDLE')
  if not bundle:raise RuntimeError('MICRODUCK_APP_BUNDLE is required')
  with tempfile.TemporaryDirectory(prefix='microduck-issuer-compat-',dir=Path.home()) as tmp:
   root=Path(tmp);(root/'sitecustomize.py').write_text("import builtins\noriginal=builtins.__import__\ndef guarded(name,*a,**k):\n if name == 'origin_service.microduck_config': raise ModuleNotFoundError('simulated old release')\n return original(name,*a,**k)\nbuiltins.__import__=guarded\n")
   env={**os.environ,'PYTHONPATH':str(root)}
   for configured in (False,True):
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    args=[os.environ.get('MICRODUCK_PYTHON','python3'),str(ACTIVE/'scripts/serve-connected.py'),'--port',str(port),'--runtime-dir',str(root/str(port)),'--origin','https://desktop.example','--apps-bundle',bundle]
    if configured:args.extend(['--microduck-runner-origin','https://runner.example'])
    proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
    try:
     if configured:
      _,err=proc.communicate(timeout=10);self.assertNotEqual(proc.returncode,0);self.assertIn('Microduck runner configuration module is unavailable',err)
     else:
      end=time.monotonic()+15;data=None
      while time.monotonic()<end:
       if proc.poll() is not None:raise AssertionError('Issuer exited: '+proc.stderr.read())
       try:
        with urlopen(Request('http://127.0.0.1:'+str(port)+'/config.json',headers={'Host':'desktop.example'}),timeout=2) as resp:data=json.load(resp)
        break
       except (OSError,URLError):time.sleep(.1)
      self.assertIsNotNone(data);self.assertNotIn('microduck',data)
    finally:
     if proc.poll() is None:proc.terminate()
     try:proc.communicate(timeout=10)
     except subprocess.TimeoutExpired:proc.kill();proc.communicate()
 def test_real_reference_issuer_exposes_explicit_origin_only(self):
  bundle=os.environ.get('MICRODUCK_APP_BUNDLE')
  if not bundle:raise RuntimeError('MICRODUCK_APP_BUNDLE is required for the actual issuer test')
  # PrivateRuntime intentionally rejects group-writable ancestors; use the
  # operator-owned home rather than the shared build-artifact volume.
  with tempfile.TemporaryDirectory(prefix='microduck-issuer-test-',dir=Path.home()) as tmp:
   for configured in (False,True):
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    args=[os.environ.get('MICRODUCK_PYTHON','python3'),str(ACTIVE/'scripts/serve-connected.py'),'--port',str(port),'--runtime-dir',str(Path(tmp)/str(port)),'--origin','https://desktop.example','--apps-bundle',bundle]
    if configured:args.extend(['--microduck-runner-origin','https://runner.example'])
    proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
     end=time.monotonic()+30;data=None
     while time.monotonic()<end:
      if proc.poll() is not None:raise AssertionError('Issuer exited: '+proc.stderr.read())
      try:
       with urlopen(Request('http://127.0.0.1:'+str(port)+'/config.json',headers={'Host':'desktop.example'}),timeout=2) as resp:
        data=json.load(resp);self.assertNotIn('https://runner.example',resp.headers['Content-Security-Policy'])
       break
      except (OSError,URLError):time.sleep(.1)
     self.assertIsNotNone(data,'Issuer did not start')
     with self.assertRaises(HTTPError) as rejected:urlopen('http://127.0.0.1:'+str(port)+'/config.json',timeout=2)
     self.assertEqual(rejected.exception.code,403);rejected.exception.close()
     if configured:self.assertEqual(data['microduck'],{'runnerOrigin':'https://runner.example'})
     else:self.assertNotIn('microduck',data)
     with urlopen(Request('http://127.0.0.1:'+str(port)+'/',headers={'Host':'desktop.example'}),timeout=2) as resp:policy=resp.headers['Content-Security-Policy']
     if configured:self.assertIn("frame-src 'self' https://runner.example",policy)
     else:self.assertNotIn('https://runner.example',policy)
    finally:
     proc.terminate()
     try:proc.communicate(timeout=10)
     except subprocess.TimeoutExpired:proc.kill();proc.communicate()

if __name__=='__main__':unittest.main()

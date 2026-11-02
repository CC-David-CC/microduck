"""The engine builder must reject invalid inputs without damaging existing files."""
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'tools'/'build-noeval-engine-candidate.sh'
class BuildEngineTest(unittest.TestCase):
 def test_missing_inputs_leave_work_directory_absent(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);work=root/'work'
   result=subprocess.run(['bash',str(SCRIPT),str(root/'source'),str(root/'sdk'),str(work)],capture_output=True,text=True)
   self.assertNotEqual(result.returncode,0);self.assertIn('source checkout',result.stderr);self.assertFalse(work.exists())
 def test_existing_work_directory_is_untouched(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);work=root/'work';work.mkdir();sentinel=work/'keep';sentinel.write_text('preserve')
   source=root/'source';source.mkdir();subprocess.run(['git','init','-q',str(source)],check=True)
   sdk=root/'sdk';tools=sdk/'upstream'/'emscripten';tools.mkdir(parents=True);(sdk/'emsdk_env.sh').write_text('')
   for name in ('emcc','emcmake'):
    f=tools/name;f.write_text('');f.chmod(0o755)
   result=subprocess.run(['bash',str(SCRIPT),str(source),str(sdk),str(work)],capture_output=True,text=True)
   self.assertNotEqual(result.returncode,0);self.assertIn('already exists',result.stderr);self.assertEqual(sentinel.read_text(),'preserve')
if __name__=='__main__':unittest.main()

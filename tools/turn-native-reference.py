"""Bounded native Microduck/MuJoCo + WASM ONNX diagnostic, not product runtime."""
import hashlib,json,math,os,subprocess,sys,xml.etree.ElementTree as ET
from pathlib import Path
import mujoco,numpy as np

root=Path(os.environ['MICRODUCK_REFERENCE_INPUTS'])
robot=root/'space/app/public/robot/mjlab'
raw=(robot/'robot_allcollisions.xml').read_bytes()
assert hashlib.sha256(raw).hexdigest()=='7a6fdf437f5a80c7348ad801f43f906b997a834389cb70cca5e1e8517ba38044'
assert mujoco.__version__=='3.17.0'
tree=ET.fromstring(raw)
for parent in tree.iter():
 for child in list(parent):
  if child.tag=='geom' and child.get('class')=='visual':parent.remove(child)
used={g.get('mesh') for g in tree.iter('geom') if g.get('mesh')}
asset=tree.find('asset');world=tree.find('worldbody');assert asset is not None and world is not None
for item in list(asset):
 if item.tag=='mesh' and (item.get('name') or Path(item.get('file')).stem) not in used:asset.remove(item)
mesh_names=[x.get('file') for x in asset.findall('mesh')];assert len(mesh_names)==9
assets={'assets/'+name:(robot/'meshes'/name).read_bytes() for name in mesh_names}
manifest=json.loads((Path(__file__).resolve().parent.parent/'project-source/manifest.json').read_text())
for path,data in assets.items():
 assert len(data)==manifest['files'][path]['bytes'] and hashlib.sha256(data).hexdigest()==manifest['files'][path]['sha256']
ET.SubElement(tree,'option',timestep='0.005')
ET.SubElement(world,'geom',name='floor',type='plane',size='0 0 0.05',pos='0 0 0')
for name,pos,size in [('wall_px','1.525 0 0.125','0.025 1.55 0.125'),('wall_nx','-1.525 0 0.125','0.025 1.55 0.125'),('wall_py','0 1.525 0.125','1.55 0.025 0.125'),('wall_ny','0 -1.525 0.125','1.55 0.025 0.125')]:ET.SubElement(world,'geom',name=name,type='box',pos=pos,size=size)
ball=ET.SubElement(world,'body',name='ball',pos='50 0 0.05');ET.SubElement(ball,'freejoint',name='ball_freejoint');ET.SubElement(ball,'geom',name='ball_geom',type='sphere',size='0.05',mass='0.03',friction='0.4 0.01 0.003',solref='0.03 0.4',condim='6')
ET.SubElement(asset,'hfield',name='terrain',nrow='65',ncol='65',size='1.5 1.5 0.07 0.1');ET.SubElement(world,'geom',name='terrain',type='hfield',hfield='terrain',pos='0 0 -0.003')
names=['left_hip_yaw','left_hip_roll','left_hip_pitch','left_knee','left_ankle','neck_pitch','head_pitch','head_yaw','head_roll','right_hip_yaw','right_hip_roll','right_hip_pitch','right_knee','right_ankle']
default=np.array([0,-0.08726646259971647,-0.457924,-0.004940,0.452984,0.3490658503988659,0.3490658503988659,0,0,0,0.08726646259971647,0.457924,0.004940,-0.452984],dtype=np.float32)
byname=dict(zip(names,default));joint_names=[j.get('name') for b in tree.iter('body') for j in b.findall('joint')];assert joint_names==names
position=[-0.6,0,0.12,1,0,0,0]+[float(byname[n]) for n in joint_names]+[50,0,0.05,1,0,0,0]
keyframes=ET.SubElement(tree,'keyframe');ET.SubElement(keyframes,'key',name='STAND',qpos=' '.join(map(str,position)),ctrl=' '.join(map(str,default.tolist())))
xml=ET.tostring(tree,encoding='unicode');model=mujoco.MjModel.from_xml_string(xml,assets=assets);data=mujoco.MjData(model)
assert (model.nq,model.nv,model.nu)==(28,26,14)
node=os.environ['MICRODUCK_REFERENCE_NODE']
def run(command,turn):
 mujoco.mj_resetDataKeyframe(model,data,model.key('STAND').id);mujoco.mj_forward(model,data)
 last=np.zeros(14,dtype=np.float32);rows=[];worker=subprocess.Popen([node,str(Path(__file__).with_name('turn-reference-worker.mjs'))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
 try:
  for tick in range(100):
   # The rotation matrix is body-local to world, so R^T maps world gravity to the body frame.
   gravity=data.body('trunk_base').xmat.reshape(3,3).T@np.array([0.,0.,-1.]);gyro=data.sensor('imu_ang_vel').data.copy()
   q=np.array([data.qpos[model.joint(n).qposadr[0]] for n in names]);v=np.array([data.qvel[model.joint(n).dofadr[0]] for n in names]);cmd=np.zeros(13,dtype=np.float32);cmd[0]=command;cmd[2]=turn
   obs=np.concatenate([gyro,gravity,q-default,v,last,cmd]).astype(np.float32);assert obs.shape==(61,) and np.isfinite(obs).all()
   sample={'validity':'valid','values':gyro.tolist()+data.body('trunk_base').xquat.tolist()+q.tolist()+v.tolist(),'sequence':tick*4+1,'capture_tick':tick*4,'available_tick':tick*4}
   worker.stdin.write(json.dumps(obs.tolist())+'\n');worker.stdin.flush();line=worker.stdout.readline();assert line,'policy process exited';action=np.asarray(json.loads(line),dtype=np.float32);assert action.shape==(14,) and np.isfinite(action).all()
   last=action.copy();data.ctrl[:]=default.astype(np.float64)+action.astype(np.float64)
   for _ in range(4):mujoco.mj_step(model,data)
   assert np.isfinite(data.qpos).all() and np.isfinite(data.qvel).all()
   rows.append({'sample':sample,'tick':tick,'time':float(data.time),'observation':obs.tolist(),'action':action.tolist(),'qpos':data.qpos.tolist(),'qvel':data.qvel.tolist(),'control':data.ctrl.tolist()})
 finally:
  worker.stdin.close();rc=worker.wait(timeout=10);assert rc==0
 return rows
left=run(.25,.5);right=run(.25,-.5)
result={'engine':mujoco.__version__,'runtime':'onnxruntime-web 1.27.0 WASM single thread','model_sha256':hashlib.sha256(raw).hexdigest(),'scene_sha256':hashlib.sha256(xml.encode()).hexdigest(),'steps_per_action':4,'timestep':0.005,'policy_steps':100,'left':left,'right':right}
for side in ['left','right']:
 result[side]=[{k:row[k] for k in ['sample','observation','action','control','qpos']} for row in result[side]]
with open(os.environ['MICRODUCK_REFERENCE_OUTPUT'],'x') as out:out.write(json.dumps(result,separators=(',',':'),allow_nan=False)+'\n')
print(json.dumps({'left_qpos':left[-1]['qpos'][:7],'right_qpos':right[-1]['qpos'][:7],'steps_per_side':400,'scene_sha256':result['scene_sha256']}))

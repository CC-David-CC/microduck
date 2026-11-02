type Reading = {tick:number;time:number;value:number};
type ScalarHandle = {describe():{joint_name:string;joint_type:string;qpos_address?:number;qvel_address?:number};read():Reading};
type InertialHandle = {read():{tick:number;time:number;stage:string;gyro:number[];quaternion:number[]};close():void};
type Plant = {bindPreForwardGyroAndOrientation(input:{sensor_name:string;body_name:string}):InertialHandle;bindJointPosition(name:string):ScalarHandle;bindJointVelocity(name:string):ScalarHandle};
/** Trusted plant-side witness for the pinned Microduck input sources. It grants no package access. */
export function createMicroduckPlantSource(plant:Plant, input:unknown) {
 if (!input || typeof input!=='object' || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) throw Error('Invalid plant source');
 const keys=Reflect.ownKeys(input);if(keys.length!==3 || !['sensor_name','body_name','joint_names'].every(k=>keys.includes(k)))throw Error('Invalid plant source');
 const field=(key:string)=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value'))throw Error('Invalid plant source');return d.value};
 const name=(value:unknown)=>{if(typeof value!=='string'||value.length<1||value.length>256||value.includes('\0'))throw Error('Invalid source name');for(const c of value){const x=c.codePointAt(0)!;if(x>=0xd800&&x<=0xdfff)throw Error('Invalid source name')}return value};
 const sensor=name(field('sensor_name')),body=name(field('body_name')),raw=field('joint_names');
 if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length!==14||Reflect.ownKeys(raw).length!==15)throw Error('Invalid joints');
 const names:string[]=[];for(let i=0;i<14;i++){const d=Object.getOwnPropertyDescriptor(raw,String(i));if(!d||!Object.hasOwn(d,'value'))throw Error('Invalid joints');names.push(name(d.value))}if(new Set(names).size!==14)throw Error('Duplicate joints');
 let inertial:InertialHandle|undefined;let closed=false;
 try{
  inertial=plant.bindPreForwardGyroAndOrientation({sensor_name:sensor,body_name:body});
  const positions=names.map(n=>plant.bindJointPosition(n));const velocities=names.map(n=>plant.bindJointVelocity(n));
  const posFacts=positions.map(h=>h.describe()),velFacts=velocities.map(h=>h.describe());
  for(let i=0;i<14;i++)if(posFacts[i].joint_name!==names[i]||velFacts[i].joint_name!==names[i]||posFacts[i].joint_type!=='hinge'||velFacts[i].joint_type!=='hinge'||!Number.isSafeInteger(posFacts[i].qpos_address)||!Number.isSafeInteger(velFacts[i].qvel_address)||Number(posFacts[i].qpos_address)<0||Number(velFacts[i].qvel_address)<0)throw Error('Invalid compiled joint source');
  if(new Set(posFacts.map(f=>f.qpos_address)).size!==14||new Set(velFacts.map(f=>f.qvel_address)).size!==14)throw Error('Duplicate compiled addresses');
  const source=inertial;
  return Object.freeze({
   describe(){if(closed)throw Error('Source closed');return {sensor_name:sensor,body_name:body,joint_names:[...names],position_facts:structuredClone(posFacts),velocity_facts:structuredClone(velFacts)}},
   read(){if(closed)throw Error('Source closed');const sample=source.read();if(!Number.isSafeInteger(sample.tick)||sample.tick<0||!Number.isFinite(sample.time)||sample.stage!==(sample.tick===0?'initial-forward':'post-step-pre-forward')||!Array.isArray(sample.gyro)||sample.gyro.length!==3||!Array.isArray(sample.quaternion)||sample.quaternion.length!==4||[...sample.gyro,...sample.quaternion].some(x=>!Number.isFinite(x)))throw Error('Invalid inertial sample');
    const p=positions.map(h=>h.read()),v=velocities.map(h=>h.read());for(const r of [...p,...v])if(r.tick!==sample.tick||!Object.is(r.time,sample.time)||!Number.isFinite(r.value))throw Error('Inconsistent source sample');
    const end=source.read();if(end.tick!==sample.tick||!Object.is(end.time,sample.time)||end.stage!==sample.stage)throw Error('Source changed during read');
    return {tick:sample.tick,time:sample.time,stage:sample.stage,gyro:[...sample.gyro],quaternion:[...sample.quaternion],jointPosition:p.map(x=>x.value),jointVelocity:v.map(x=>x.value)};
   },
   close(){if(!closed){closed=true;source.close()}}
  });
 }catch(error){if(inertial)inertial.close();throw error}
}


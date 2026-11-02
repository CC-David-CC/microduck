type Identity={session_id:string;project_revision:string;run_epoch:number};
type Source={describe():unknown;read():{tick:number;time:number;stage:string;gyro:number[];quaternion:number[];jointPosition:number[];jointVelocity:number[]};close():void};
const layout=[{name:'gyro',size:3,unit:'rad/s',stage:'initial-forward-or-post-step-pre-forward'},
 {name:'body_quaternion_wxyz',size:4,unit:'1',stage:'initial-forward-or-post-step-pre-forward'},
 {name:'joint_position',size:14,unit:'rad',stage:'current-qpos'},
 {name:'joint_velocity',size:14,unit:'rad/s',stage:'current-qvel'}];
function canonical(v:unknown,depth=0):unknown{
 if(depth>16)throw Error('Definition too deep');if(v===null)return ['null'];
 if(typeof v==='string')return ['string',v];if(typeof v==='boolean')return ['boolean',v];
 if(typeof v==='number'){if(!Number.isFinite(v))throw Error('Invalid definition number');const b=new ArrayBuffer(8);new DataView(b).setFloat64(0,v,false);return ['f64',Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('')]}
 if(typeof v!=='object')throw Error('Invalid definition');
 if(Array.isArray(v)){if(Object.getPrototypeOf(v)!==Array.prototype||Reflect.ownKeys(v).length!==v.length+1||v.length>256)throw Error('Invalid definition array');return ['array',Array.from({length:v.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!Object.hasOwn(d,'value'))throw Error('Invalid definition array');return canonical(d.value,depth+1)})]}
 if(![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error('Invalid definition record');const names=Reflect.ownKeys(v);if(names.length>256||names.some(x=>typeof x!=='string'))throw Error('Invalid definition record');
 return ['object',(names as string[]).sort().map(k=>{const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)throw Error('Invalid definition field');return [k,canonical(d.value,depth+1)]})];
}
/** Exact, deterministic inert representation; binary64 values include signed zero. */
export function encodeMicroduckTruthDefinition(value:unknown):unknown{return canonical(value);}
export function decodeMicroduckTruthDefinition(input:unknown):unknown {
 function decode(node:any,depth:number):unknown {
  if(depth>16||!Array.isArray(node)||node.length<1||node.length>2)throw Error('Invalid canonical definition');
  const [kind,value]=node;
  if(kind==='null'&&node.length===1)return null;
  if(kind==='string'&&node.length===2&&typeof value==='string')return value;
  if(kind==='boolean'&&node.length===2&&typeof value==='boolean')return value;
  if(kind==='f64'&&node.length===2&&typeof value==='string'&&/^[0-9a-f]{16}$/.test(value)){
   const d=new DataView(new ArrayBuffer(8));d.setBigUint64(0,BigInt('0x'+value),false);const n=d.getFloat64(0,false);if(!Number.isFinite(n))throw Error('Invalid canonical number');return n;
  }
  if(kind==='array'&&node.length===2&&Array.isArray(value)&&value.length<=256)return value.map((v:any)=>decode(v,depth+1));
  if(kind==='object'&&node.length===2&&Array.isArray(value)&&value.length<=256){
   const result:Record<string,unknown>={},seen=new Set<string>();let last:string|null=null;
   for(const pair of value){if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||seen.has(pair[0])||(last!==null&&last>=pair[0]))throw Error('Invalid canonical fields');
    seen.add(pair[0]);last=pair[0];Object.defineProperty(result,pair[0],{value:decode(pair[1],depth+1),enumerable:true,writable:true,configurable:true});}
   return result;
  }
  throw Error('Invalid canonical definition');
 }
 const result=decode(input,0);if(JSON.stringify(canonical(result))!==JSON.stringify(input))throw Error('Noncanonical definition');return result;
}
/** Hash the complete source and timing definition using the channel's canonical encoding. */
export async function microduckTruthDefinitionHash(value:unknown):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify(canonical(value)));if(bytes.length>65536)throw Error('Definition too large');
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
}
function identityCopy(v:Identity):Identity {if(!v||typeof v.session_id!=='string'||!v.session_id||v.session_id.length>256||typeof v.project_revision!=='string'||!/^[a-f0-9]{64}$/.test(v.project_revision)||!Number.isSafeInteger(v.run_epoch)||v.run_epoch<0)throw Error('Invalid identity');return {session_id:v.session_id,project_revision:v.project_revision,run_epoch:v.run_epoch};}
/** A trusted truth channel; possession of it does not grant a controller access. */
export async function createMicroduckTruthChannel(identity:Identity,source:Source,id:string){
 let bound=identityCopy(identity);if(typeof id!=='string'||!id||id.length>256||id.includes('\0'))throw Error('Invalid channel id');
 const facts=structuredClone(source.describe()),definition={version:'brf.microduck-plant-truth.v1',project_revision:bound.project_revision,id,layout,source:facts};
 const digest=await microduckTruthDefinitionHash(definition);
 if(JSON.stringify(canonical(source.describe()))!==JSON.stringify(canonical(facts)))throw Error('Source changed during binding');
 let closed=false,lastTick=-1;const channel={id,kind:'truth',size:35,unit:'mixed',frame:null,definition_sha256:digest,source_ids:[]};
 return Object.freeze({describe(){if(closed)throw Error('Channel closed');return structuredClone(channel)},describeDefinition(){if(closed)throw Error('Channel closed');return structuredClone(definition)},
  read(current:Identity){if(closed)throw Error('Channel closed');const now=identityCopy(current);if(now.session_id!==bound.session_id||now.project_revision!==bound.project_revision||now.run_epoch!==bound.run_epoch)throw Error('Identity changed');if(JSON.stringify(canonical(source.describe()))!==JSON.stringify(canonical(facts)))throw Error('Source definition changed');
   const sample=source.read();if(!Number.isSafeInteger(sample.tick)||sample.tick<0||sample.tick>=Number.MAX_SAFE_INTEGER||sample.tick<lastTick||!Number.isFinite(sample.time)||sample.stage!==(sample.tick===0?'initial-forward':'post-step-pre-forward'))throw Error('Invalid source stage');
   const values:number[]=[];for(const [array,size] of [[sample.gyro,3],[sample.quaternion,4],[sample.jointPosition,14],[sample.jointVelocity,14]] as const){if(!Array.isArray(array)||Object.getPrototypeOf(array)!==Array.prototype||array.length!==size||Reflect.ownKeys(array).length!==size+1)throw Error('Invalid source values');for(let i=0;i<size;i++){const d=Object.getOwnPropertyDescriptor(array,String(i));if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='number'||!Number.isFinite(d.value))throw Error('Invalid source values');values.push(d.value)}}
   lastTick=sample.tick;return {identity:{...bound},observed_tick:sample.tick,time:sample.time,stage:sample.stage,channel:structuredClone(channel),sample:{validity:'valid',values,sequence:sample.tick+1,capture_tick:sample.tick,available_tick:sample.tick}};
  },reset(next:Identity){if(closed)throw Error('Channel closed');const id=identityCopy(next);if(id.session_id!==bound.session_id||id.project_revision!==bound.project_revision||id.run_epoch!==bound.run_epoch+1)throw Error('Invalid next epoch');bound=id;lastTick=-1;},close(){if(!closed){closed=true;source.close()}}});
}



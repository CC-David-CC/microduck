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
function identityCopy(v:Identity):Identity {if(!v||typeof v.session_id!=='string'||!v.session_id||v.session_id.length>256||typeof v.project_revision!=='string'||!/^[a-f0-9]{64}$/.test(v.project_revision)||!Number.isSafeInteger(v.run_epoch)||v.run_epoch<0)throw Error('Invalid identity');return {session_id:v.session_id,project_revision:v.project_revision,run_epoch:v.run_epoch};}
/** A trusted truth channel; possession of it does not grant a controller access. */
export async function createMicroduckTruthChannel(identity:Identity,source:Source,id:string){
 let bound=identityCopy(identity);if(typeof id!=='string'||!id||id.length>256||id.includes('\0'))throw Error('Invalid channel id');
 const facts=structuredClone(source.describe()),definition={version:'brf.microduck-plant-truth.v1',project_revision:bound.project_revision,id,layout,source:facts};
 const serialized=JSON.stringify(canonical(definition));const bytes=new TextEncoder().encode(serialized);if(bytes.length>65536)throw Error('Definition too large');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 if(JSON.stringify(canonical(source.describe()))!==JSON.stringify(canonical(facts)))throw Error('Source changed during binding');
 let closed=false,lastTick=-1;const channel={id,kind:'truth',size:35,unit:'mixed',frame:null,definition_sha256:digest,source_ids:[]};
 return Object.freeze({describe(){if(closed)throw Error('Channel closed');return structuredClone(channel)},describeDefinition(){if(closed)throw Error('Channel closed');return structuredClone(definition)},
  read(current:Identity){if(closed)throw Error('Channel closed');const now=identityCopy(current);if(now.session_id!==bound.session_id||now.project_revision!==bound.project_revision||now.run_epoch!==bound.run_epoch)throw Error('Identity changed');if(JSON.stringify(canonical(source.describe()))!==JSON.stringify(canonical(facts)))throw Error('Source definition changed');
   const sample=source.read();if(!Number.isSafeInteger(sample.tick)||sample.tick<0||sample.tick>=Number.MAX_SAFE_INTEGER||sample.tick<lastTick||!Number.isFinite(sample.time)||sample.stage!==(sample.tick===0?'initial-forward':'post-step-pre-forward'))throw Error('Invalid source stage');
   const values:number[]=[];for(const [array,size] of [[sample.gyro,3],[sample.quaternion,4],[sample.jointPosition,14],[sample.jointVelocity,14]] as const){if(!Array.isArray(array)||Object.getPrototypeOf(array)!==Array.prototype||array.length!==size||Reflect.ownKeys(array).length!==size+1)throw Error('Invalid source values');for(let i=0;i<size;i++){const d=Object.getOwnPropertyDescriptor(array,String(i));if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='number'||!Number.isFinite(d.value))throw Error('Invalid source values');values.push(d.value)}}
   lastTick=sample.tick;return {identity:{...bound},observed_tick:sample.tick,time:sample.time,stage:sample.stage,channel:structuredClone(channel),sample:{validity:'valid',values,sequence:sample.tick+1,capture_tick:sample.tick,available_tick:sample.tick}};
  },reset(next:Identity){if(closed)throw Error('Channel closed');const id=identityCopy(next);if(id.session_id!==bound.session_id||id.project_revision!==bound.project_revision||id.run_epoch!==bound.run_epoch+1)throw Error('Invalid next epoch');bound=id;lastTick=-1;},close(){if(!closed){closed=true;source.close()}}});
}



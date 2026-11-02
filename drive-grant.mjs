// This capability grants declared high-level targets, never direct actuator access.
export function createDriveGrant(getSession) {
 if(typeof getSession!=='function')throw Error('Session provider required');
 let grant=null,version=0;
 const identity=session=>{
  const v=session?.identity;
  if(!v||typeof v.session_id!=='string'||!v.session_id||typeof v.project_revision!=='string'||!/^[a-f0-9]{64}$/.test(v.project_revision)||!Number.isSafeInteger(v.run_epoch)||v.run_epoch<0||typeof session.setTarget!=='function')throw Error('Session unavailable');
  return {session_id:v.session_id,project_revision:v.project_revision,run_epoch:v.run_epoch};
 };
 const same=(a,b)=>a.session_id===b.session_id&&a.project_revision===b.project_revision&&a.run_epoch===b.run_epoch;
 const current=(session,expected,token)=>{try{return version===token&&grant!==null&&getSession()===session&&same(identity(session),expected)}catch{return false}};
 return Object.freeze({
  enable(){const session=getSession(),id=identity(session);version++;grant={session,id};},
  revoke(){version++;grant=null;},
  async drive(input){
   if(!grant)throw Error('Agent drive grant required');
   if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).length!==1)throw Error('Invalid drive request');
   const field=Reflect.ownKeys(input)[0];
   if(field!=='speed'&&field!=='turn')throw Error('Invalid drive target');
   const value=Object.getOwnPropertyDescriptor(input,field),min=field==='speed'?0:-1,max=field==='speed'?.25:1;
   if(!value||!Object.hasOwn(value,'value')||!value.enumerable||typeof value.value!=='number'||!Number.isFinite(value.value)||value.value<min||value.value>max)throw Error('Invalid drive target');
   const {session,id}=grant,token=version;if(!current(session,id,token))throw Error('Agent drive grant expired');
   try{const result=await session.setTarget({group_id:'all',field,value:value.value});if(!current(session,id,token))return {status:'unknown'};return result}
   catch(error){if(!current(session,id,token))return {status:'unknown'};throw error}
  }
 });
}

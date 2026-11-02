/** Bind the fixed published rig to the compiled world's named body identities. */
export function bindPublishedDuckRig(rig:unknown,model:any){
 if(!Array.isArray(rig)||rig.length!==15||!Array.isArray(model?.bodies)||model.bodies.length>4096)throw Error('Invalid Microduck rig binding');
 const seen=new Set<string>(),binding:{name:string;id:number}[]=[];
 for(const body of rig){
  if(!body||typeof body.name!=='string'||!body.name||seen.has(body.name))throw Error('Invalid Microduck body');seen.add(body.name);
  const matches=model.bodies.filter((x:any)=>x?.name===body.name);
  if(matches.length!==1||!Number.isSafeInteger(matches[0].id)||matches[0].id<1||matches[0].id>=model.bodies.length||model.bodies[matches[0].id]!==matches[0])throw Error('Microduck body is unavailable');
  binding.push(Object.freeze({name:body.name,id:matches[0].id}));
 }
 return Object.freeze(binding);
}
/** Presentation-only snapshots; never supplies commands or sensor observations. */
export function projectPublishedDuckFrame(binding:readonly {name:string;id:number}[],frame:any){
 if(!Array.isArray(binding)||binding.length!==15||!Number.isSafeInteger(frame?.tick)||frame.tick<0||!Array.isArray(frame.bodies)||frame.bodies.length>4096)throw Error('Invalid Microduck frame');
 return binding.map(({name,id})=>{
  const p=frame.bodies[id],v=(x:any,n:number)=>Array.isArray(x)&&x.length===n&&x.every((y:any)=>typeof y==='number'&&Number.isFinite(y));
  if(!p||p.id!==id||!v(p.position,3)||!v(p.quaternion,4)||Math.abs(Math.hypot(...p.quaternion)-1)>1e-6)throw Error('Invalid Microduck body pose');
  return Object.freeze({name,position:Object.freeze([...p.position]),quaternion:Object.freeze([...p.quaternion])});
 });
}

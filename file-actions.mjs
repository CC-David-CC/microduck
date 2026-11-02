// Account-backed file bridge for the existing shared project/experiment format.
export function createFileActions(host,getApplication,isAlive) {
 let busy=false;
 function check(context,owner){if(!isAlive()||host.signal?.aborted||!context.valid()||context.owner!==owner||host.storage.signedInSubject()!==owner)throw Error('Window or account changed')}
 async function run(operation){if(busy)throw Error('Another file operation is in progress');busy=true;try{return await operation()}finally{busy=false}}
 return Object.freeze({
  saveAs(){return run(async()=>{
   const owner=host.storage.signedInSubject();if(!owner)throw Error('Sign in to save to My files');
   const folder=await host.storage.pickFolder({signal:host.signal});if(folder===null)return null;
   const context=await host.storage.mirrorFileContext();check(context,owner);
   const name=context.name('Microduck.brf'),path=context.path((folder==='/'?'':folder)+'/'+name);
   let expected=null;
   if(typeof context.files.stat==='function'){
    let existing=null;
    try{existing=await context.files.stat(path)}catch(error){if(error?.message!=='File not found.')throw error}
    check(context,owner);
    if(existing){
     if(existing.status==='conflict')throw Error('Resolve the file conflict in My files first');
     if(typeof host.ui?.confirm!=='function')throw Error('Replacement confirmation unavailable');
     const approved=await host.ui.confirm('Replace '+path+'?',{title:'Replace Microduck project',confirmLabel:'Replace',cancelLabel:'Cancel',signal:host.signal});
     check(context,owner);if(!approved)return null;
     if(typeof existing.version!=='string'||!existing.version)throw Error('File version unavailable');
     expected=existing.version;
    }
   }
   const app=getApplication();if(!app)throw Error('Project is not open');
   const captured=await app.captureFile();check(context,owner);
   if(!captured.isCurrent())throw Error('Project changed before saving');
   const data=new Uint8Array(await captured.blob.arrayBuffer());check(context,owner);
   if(!captured.isCurrent())throw Error('Project changed before saving');
   const result=await context.files.write(path,data,expected);
   try{check(context,owner)}catch{throw Error('The account changed; the save outcome may be unknown')}
   return {path,status:result.status,version:result.version,current:captured.isCurrent()};
  })},
  open(){return run(async()=>{
   const owner=host.storage.signedInSubject();if(!owner)throw Error('Sign in to open My files');
   const choice=await host.storage.pickFile({extensions:['.brf'],signal:host.signal});if(choice===null)return null;
   const context=await host.storage.mirrorFileContext();check(context,owner);
   const path=context.path(choice),file=await context.files.read(path);check(context,owner);
   if(file.status==='conflict')throw Error('Resolve the file conflict in My files first');
   if(!(file.data instanceof Uint8Array)||file.data.byteLength>67108864)throw Error('Project file is invalid or too large');
   const app=getApplication();if(!app)throw Error('Project is not open');
   await app.replaceFile(new File([file.data],'microduck.brf',{type:'application/json'}),()=>{try{check(context,owner);return true}catch{return false}});
   check(context,owner);
   return {path,version:file.version,status:file.status};
  })}
 });
}

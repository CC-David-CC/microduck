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
   if(typeof host.ui?.prompt!=='function')throw Error('Filename entry unavailable');
   const chosen=await host.ui.prompt('Project filename:',{title:'Save Microduck project',value:'Microduck.brf',confirmLabel:'Save',signal:host.signal});
   check(context,owner);if(chosen===null)return null;
   const name=context.name(chosen.trim());if(!/\.brf$/i.test(name))throw Error('Use a .brf filename');
   const path=context.path((folder==='/'?'':folder)+'/'+name);
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
  open(selected){return run(async()=>{
   const owner=host.storage.signedInSubject();if(!owner)throw Error('Sign in to open My files');
   const choice=selected??await host.storage.pickFile({extensions:['.brf'],signal:host.signal});if(choice===null)return null;
   const context=await host.storage.mirrorFileContext();check(context,owner);
   const path=context.path(choice);if(!/\.brf$/i.test(path))throw Error('Choose a .brf project');
   const file=await context.files.read(path);check(context,owner);
   if(file.status==='conflict')throw Error('Resolve the file conflict in My files first');
   if(typeof file.version!=='string'||!file.version)throw Error('Project version unavailable');
   if(!(file.data instanceof Uint8Array)||file.data.byteLength>67108864)throw Error('Project file is invalid or too large');
   const app=getApplication();if(!app)throw Error('Project is not open');
   const validate=async()=>{const current=await context.files.stat(path);check(context,owner);if(current.status==='conflict'||current.version!==file.version)throw Error('The project changed while opening; try again')};
   await validate();
   await app.replaceFile(new File([file.data],path.split('/').pop(),{type:'application/json'}),()=>{try{check(context,owner);return true}catch{return false}},validate);
   check(context,owner);
   return {path,version:file.version,status:file.status,owner};
  })}
 });
}

// Record only a successful swap in the account-bound desktop layout. Never
// let a late completion attach a private path to a different session.
export function rememberOpenedFile(host,result) {
 if(!result||typeof result.path!=='string'||typeof result.owner!=='string'||!host.w||host.signal?.aborted||host.storage.signedInSubject()!==result.owner)return false;
 host.w.launchContext=Object.freeze({version:1,storage:'mirror',path:result.path,owner:result.owner});
 host.w.ownerSub=result.owner;
 try{host.desktop?.saveLayout?.()}catch{/* the open succeeded even if layout persistence fails */}
 return true;
}

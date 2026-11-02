import {safeProjectPath} from './project-path.ts';
import {unicodeDefaultCaseFold17} from './unicode-casefold.ts';

export type ProjectFolderLimits = {max_files:number;max_file_bytes:number;max_total_bytes:number;max_depth:number;max_path_length:number};
const blobSize=Object.getOwnPropertyDescriptor(Blob.prototype,'size')!.get!;
const readBlob=Blob.prototype.arrayBuffer;

/** Read a selected directory capability into owned bytes. This is acquisition,
 * not package admission, profile approval, or an atomic filesystem snapshot. */
export async function acquireProjectFolder(directory:any, limits:ProjectFolderLimits, options:{signal?:AbortSignal}={}):Promise<{path:string;data:Uint8Array}[]> {
 const keys=['max_files','max_file_bytes','max_total_bytes','max_depth','max_path_length'] as const;
 if(!limits||typeof limits!=='object'||Array.isArray(limits)||![Object.prototype,null].includes(Object.getPrototypeOf(limits))||Reflect.ownKeys(limits).length!==keys.length)throw new Error('Invalid folder limits');
 const caps={} as ProjectFolderLimits;
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(limits,key);if(!d||!Object.hasOwn(d,'value')||!Number.isSafeInteger(d.value)||d.value<1)throw new Error('Invalid folder limits');caps[key]=d.value;}
 if(caps.max_files>4096||caps.max_file_bytes>67108864||caps.max_total_bytes>268435456||caps.max_depth>64||caps.max_path_length>960)throw new Error('Folder limits exceed supported bounds');
 if(!options||typeof options!=='object'||Array.isArray(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options))||Reflect.ownKeys(options).some(k=>k!=='signal'))throw new Error('Invalid folder options');
 const descriptor=Object.getOwnPropertyDescriptor(options,'signal');if(descriptor&&!Object.hasOwn(descriptor,'value'))throw new Error('Invalid folder options');
 const signal=descriptor?.value;if(signal!==undefined&&!(signal instanceof AbortSignal))throw new Error('Invalid abort signal');
 const check=()=>{if(signal?.aborted)throw new DOMException('Folder acquisition aborted','AbortError');};
 const entries:{path:string;data:Uint8Array}[]=[],seenDirs:any[]=[],namespace=new Map<string,{path:string;directory:boolean}>();
 let total=0,enumerated=0;
 function namePath(prefix:string,name:unknown,isDirectory:boolean):string {
  if(typeof name!=='string'||name.includes('/'))throw new Error('Invalid folder entry name');
  const path=safeProjectPath(prefix?prefix+'/'+name:name);
  if([...path].length>caps.max_path_length)throw new Error('Folder path exceeds limit');
  const key=unicodeDefaultCaseFold17(path.normalize('NFD')).normalize('NFD'),previous=namespace.get(key);
  if(previous)throw new Error('Conflicting folder path');
  namespace.set(key,{path,directory:isDirectory});return path;
 }
 async function visit(dir:any,prefix:string,depth:number):Promise<void> {
  check();if(!dir||dir.kind!=='directory'||typeof dir.entries!=='function'||typeof dir.isSameEntry!=='function')throw new Error('Invalid directory handle');
  if(seenDirs.length>=1024)throw new Error('Directory count exceeds limit');
  for(const prior of seenDirs){check();if(await dir.isSameEntry(prior))throw new Error('Directory alias or cycle');check();}
  seenDirs.push(dir);
  for await(const item of dir.entries()){
   check();if(++enumerated>8192)throw new Error('Folder entry count exceeds limit');
   if(!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||!item[1]||item[1].name!==item[0])throw new Error('Invalid folder entry');
   const handle=item[1],isDirectory=handle.kind==='directory';if(!isDirectory&&handle.kind!=='file')throw new Error('Invalid folder entry');
   const path=namePath(prefix,item[0],isDirectory);
   if(isDirectory){if(depth>=caps.max_depth)throw new Error('Folder depth exceeds limit');await visit(handle,path,depth+1);continue;}
   if(entries.length>=caps.max_files||typeof handle.getFile!=='function')throw new Error('Folder file limit exceeded');
   const file=await handle.getFile();check();let size:number;try{size=Reflect.apply(blobSize,file,[]);}catch{throw new Error('Invalid native file snapshot');}
   if(!Number.isSafeInteger(size)||size<0||size>caps.max_file_bytes||size>caps.max_total_bytes-total)throw new Error('Folder byte limit exceeded');
   const buffer=await Reflect.apply(readBlob,file,[]);check();
   if(!(buffer instanceof ArrayBuffer)||buffer.byteLength!==size)throw new Error('File snapshot changed');
   const data=new Uint8Array(buffer.slice(0));total+=data.byteLength;entries.push({path,data});
  }
  check();
 }
 await visit(directory,'',0);check();return entries;
}

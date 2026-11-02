import {captureProjectInventory, isCapturedProjectInventory} from './project-inventory.ts';
import type {ProjectInventory, ProjectInventoryLimits} from './project-inventory.ts';
import {readManifestJson} from './manifest-json.ts';

type Kind = 'game' | 'research';
type Caps = {max_bundle_bytes:number;max_records:number;max_record_bytes:number;max_total_record_bytes:number;inventory:ProjectInventoryLimits};
type InputRecord = {id:string;kind:Kind;content:Blob};
type FileRow = {path:string;data_base64:string};
type RecordRow = {id:string;kind:Kind;content_base64:string;sha256:string};
const encoder=new TextEncoder();
const sizeGetter=Object.getOwnPropertyDescriptor(Blob.prototype,'size')!.get!;
const read=Blob.prototype.arrayBuffer;
function exact(value:unknown, keys:readonly string[]):value is Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  const own=Reflect.ownKeys(value);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&!!Object.getOwnPropertyDescriptor(value,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value'));
}
function capsOf(value:unknown):Caps {
  if(!exact(value,['max_bundle_bytes','max_records','max_record_bytes','max_total_record_bytes','inventory']))throw Error('Invalid file limits');
  for(const k of ['max_bundle_bytes','max_records','max_record_bytes','max_total_record_bytes'] as const)if(!Number.isSafeInteger(value[k])||value[k]<1)throw Error('Invalid file limit');
  if(value.max_bundle_bytes>134217728||value.max_records>4096||value.max_record_bytes>67108864||value.max_total_record_bytes>134217728)throw Error('File limit too large');
  const input=value.inventory;if(!exact(input,['max_files','max_total_bytes','max_file_bytes','max_manifest_bytes','max_manifest_depth']))throw Error('Invalid inventory limits');
  const inventory={} as ProjectInventoryLimits;for(const k of ['max_files','max_total_bytes','max_file_bytes','max_manifest_bytes','max_manifest_depth'] as const){if(!Number.isSafeInteger(input[k])||input[k]<1)throw Error('Invalid inventory limit');inventory[k]=input[k]}
  return {max_bundle_bytes:value.max_bundle_bytes,max_records:value.max_records,max_record_bytes:value.max_record_bytes,max_total_record_bytes:value.max_total_record_bytes,inventory};
}
function identity(id:unknown,kind:unknown):asserts id is string {if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id)||(kind!=='game'&&kind!=='research'))throw Error('Invalid record identity');}
function ownedBlob(value:unknown,max:number):Blob {if(!(value instanceof Blob))throw Error('Expected Blob');const n:number=Reflect.apply(sizeGetter,value,[]);if(!Number.isSafeInteger(n)||n<0||n>max)throw Error('Blob exceeds limit');const copy=structuredClone(value);if(!(copy instanceof Blob)||Reflect.apply(sizeGetter,copy,[])!==n)throw Error('Invalid Blob');return copy;}
async function bytesOf(value:Blob):Promise<Uint8Array>{return new Uint8Array(await Reflect.apply(read,value,[]));}
function b64(bytes:Uint8Array):string {let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s)}
function un64(value:unknown,max:number):Uint8Array {
  if(typeof value!=='string'||value.length>4*Math.ceil(max/3)||value.length%4!==0)throw Error('Invalid base64');
  for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);const alphabet=(c>=65&&c<=90)||(c>=97&&c<=122)||(c>=48&&c<=57)||c===43||c===47;if(!alphabet&&!(c===61&&i>=value.length-2))throw Error('Invalid base64')}
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;const decodedLength=value.length/4*3-padding;if(decodedLength>max)throw Error('Decoded data exceeds limit');
  let s:string;try{s=atob(value)}catch{throw Error('Invalid base64')}if(s.length>max)throw Error('Decoded data exceeds limit');const b=new Uint8Array(s.length);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);if(b64(b)!==value)throw Error('Noncanonical base64');return b;
}
async function digest(data:Uint8Array):Promise<string>{const output=new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(data)));return Array.from(output,x=>x.toString(16).padStart(2,'0')).join('')}
const core=(files:FileRow[],records:RecordRow[])=>({format:'brf-project-experiment/1',files,records});
export async function encodeExperimentFile(inventory:Readonly<ProjectInventory>,input:readonly InputRecord[],limits:unknown):Promise<Blob> {
  const caps=capsOf(limits);if(!isCapturedProjectInventory(inventory))throw Error('Inventory is not captured');if(!Array.isArray(input)||input.length>caps.max_records)throw Error('Record count exceeded');
  const seen=new Set<string>(),recordsOwned=input.map(row=>{if(!exact(row,['id','kind','content']))throw Error('Invalid record');identity(row.id,row.kind);if(seen.has(row.id))throw Error('Duplicate record');seen.add(row.id);return {id:row.id,kind:row.kind as Kind,content:ownedBlob(row.content,caps.max_record_bytes)}});
  let total=0;for(const row of recordsOwned){const n:number=Reflect.apply(sizeGetter,row.content,[]);if(n>caps.max_total_record_bytes-total)throw Error('Record total exceeded');total+=n}
  const names=Object.keys(inventory.files);if(names.length>caps.inventory.max_files||inventory.total_bytes>caps.inventory.max_total_bytes)throw Error('Source limits exceeded');const files:FileRow[]=[],entries:Array<{path:string;data:Uint8Array}>=[];for(const path of names){const f=inventory.files[path];if(f.bytes>caps.inventory.max_file_bytes||(path==='manifest.json'&&f.bytes>caps.inventory.max_manifest_bytes))throw Error('File too large');const bytes=await bytesOf(f.content);files.push({path,data_base64:b64(bytes)});entries.push({path,data:bytes})}const checked=await captureProjectInventory(entries,caps.inventory);if(checked.project_revision!==inventory.project_revision)throw Error('Source identity mismatch');
  const records:RecordRow[]=[];for(const row of recordsOwned){const data=await bytesOf(row.content);records.push({id:row.id,kind:row.kind,content_base64:b64(data),sha256:await digest(data)})}
  const body=core(files,records),checksum=await digest(encoder.encode(JSON.stringify(body))),result=new Blob([JSON.stringify({...body,checksum})],{type:'application/json'});if(result.size>caps.max_bundle_bytes)throw Error('File exceeds limit');return result;
}
export async function decodeExperimentFile(input:Blob,limits:unknown) {
  const caps=capsOf(limits),owned=ownedBlob(input,caps.max_bundle_bytes),doc=await readManifestJson(owned,{max_bytes:caps.max_bundle_bytes,max_depth:16}),data=doc.data;
  if(!exact(data,['format','files','records','checksum'])||data.format!=='brf-project-experiment/1'||!Array.isArray(data.files)||!Array.isArray(data.records)||data.files.length>caps.inventory.max_files||data.records.length>caps.max_records||typeof data.checksum!=='string'||!/^[0-9a-f]{64}$/.test(data.checksum))throw Error('Invalid experiment file');
  const files:FileRow[]=[],entries:Array<{path:string;data:Uint8Array}>=[];let sourceTotal=0;for(const value of data.files){if(!exact(value,['path','data_base64'])||typeof value.path!=='string')throw Error('Invalid source record');const remaining=caps.inventory.max_total_bytes-sourceTotal,perFile=value.path==='manifest.json'?Math.min(caps.inventory.max_file_bytes,caps.inventory.max_manifest_bytes):caps.inventory.max_file_bytes;const bytes=un64(value.data_base64,Math.min(perFile,remaining));sourceTotal+=bytes.length;files.push({path:value.path,data_base64:value.data_base64});entries.push({path:value.path,data:bytes})}
  let total=0;const seen=new Set<string>(),records:RecordRow[]=[],loaded:Array<{id:string;kind:Kind;provenance:'unverified';content:Blob}>=[];for(const value of data.records){if(!exact(value,['id','kind','content_base64','sha256']))throw Error('Invalid experiment record');identity(value.id,value.kind);if(seen.has(value.id))throw Error('Duplicate record');seen.add(value.id);if(typeof value.sha256!=='string'||!/^[0-9a-f]{64}$/.test(value.sha256))throw Error('Invalid record digest');const bytes=un64(value.content_base64,Math.min(caps.max_record_bytes,caps.max_total_record_bytes-total));total+=bytes.length;if(await digest(bytes)!==value.sha256)throw Error('Record digest mismatch');records.push({id:value.id,kind:value.kind as Kind,content_base64:value.content_base64,sha256:value.sha256});loaded.push(Object.freeze({id:value.id,kind:value.kind as Kind,provenance:'unverified',content:new Blob([new Uint8Array(bytes)])}))}
  if(await digest(encoder.encode(JSON.stringify(core(files,records))))!==data.checksum)throw Error('File checksum mismatch');const inventory=await captureProjectInventory(entries,caps.inventory);return Object.freeze({kind:'inventory-only' as const,runReady:false as const,inventory,records:Object.freeze(loaded)});
}

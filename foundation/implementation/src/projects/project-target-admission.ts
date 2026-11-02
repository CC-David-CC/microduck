import {isCapturedProjectInventory, type ProjectInventory} from './project-inventory.ts';
import {safeProjectPath} from './project-path.ts';
import {readManifestJson} from './manifest-json.ts';
import {copyBounded} from '../session/project-world-wire.ts';

type Target = {group_id:string; field:string; min:number; max:number};
function exact(value:any, keys:string[]):boolean {
  return !!value && typeof value==='object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null) &&
    Reflect.ownKeys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
}
/** Read declarations from captured source. This does not grant controller authority. */
export async function readProjectTargetDeclarations(inventory:Readonly<ProjectInventory>) {
  if (!isCapturedProjectInventory(inventory)) throw Error('Project inventory is not captured');
  const data=inventory.envelope.document.data;
  if (!Object.hasOwn(data,'target_declarations')) return Object.freeze({project_revision:inventory.project_revision,source:null,targets:Object.freeze([])});
  const path=safeProjectPath(data.target_declarations),file=inventory.files[path];
  if (!file || path==='manifest.json' || file.bytes>32768) throw Error('Invalid target source');
  const doc=await readManifestJson(file.content,{max_bytes:32768,max_depth:8}),value:any=doc.data;
  if (!exact(value,['schema_version','targets']) || value.schema_version!==1 || !Array.isArray(value.targets) || value.targets.length>128) throw Error('Invalid target document');
  const seen=new Set<string>(),targets:Readonly<Target>[]=[];
  for (const row of value.targets) {
    if (!exact(row,['group_id','field','min','max']) || typeof row.group_id!=='string' || !row.group_id || row.group_id.length>256 ||
        typeof row.field!=='string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.field) ||
        typeof row.min!=='number' || !Number.isFinite(row.min) || typeof row.max!=='number' || !Number.isFinite(row.max) || row.min>row.max) throw Error('Invalid target');
    const key=JSON.stringify([row.group_id,row.field]);if(seen.has(key))throw Error('Target not bound');
    seen.add(key);targets.push(Object.freeze({group_id:row.group_id,field:row.field,min:row.min,max:row.max}));
  }
  return Object.freeze({project_revision:inventory.project_revision,source:Object.freeze({path,sha256:file.sha256}),targets:Object.freeze(targets)});
}
/** Test-only draft. Declarations constrain targets; they confer no authority. */
export async function captureProjectTargets(inventory:Readonly<ProjectInventory>, input:unknown) {
  if (!isCapturedProjectInventory(inventory)) throw Error('Project inventory is not captured');
  const controllers=copyBounded(input,65536);
  if (!Array.isArray(controllers) || controllers.length>64) throw Error('Invalid controllers');
  const byGroup=new Map<string,Record<string,unknown>>();
  for (const c of controllers) {
    if (!exact(c,['group_id','intent']) || typeof c.group_id!=='string' || !c.group_id || c.group_id.length>256 ||
        byGroup.has(c.group_id) || !c.intent || typeof c.intent!=='object' || Array.isArray(c.intent)) throw Error('Invalid controller');
    byGroup.set(c.group_id,c.intent);
  }
  const declarations=await readProjectTargetDeclarations(inventory);
  for(const row of declarations.targets){
    const intent=byGroup.get(row.group_id);
    if(!intent || !Object.hasOwn(intent,row.field) || typeof intent[row.field]!=='number' ||
       (intent[row.field] as number)<row.min || (intent[row.field] as number)>row.max)throw Error('Target not bound');
  }
  return declarations;
}

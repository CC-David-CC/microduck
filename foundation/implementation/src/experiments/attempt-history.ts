/** Session-local notes, not verified experiment definitions or scientific results. */
export type AttemptDeclaration = Readonly<{project_revision:string;configuration_sha256:string;runtime_lock_sha256:string}>;
export type AttemptIdentity = Readonly<{session_id:string;project_revision:string;run_epoch:number}>;
export type AttemptNoteStatus = 'planned'|'running'|'completed'|'cancelled'|'deadline'|'failed'|'unknown'|'unavailable';
type AttemptNote = {id:string;requested_ticks:number;declaration:AttemptDeclaration;identity:AttemptIdentity|null;
  status:AttemptNoteStatus;last_verified_tick:number|null;reported_steps:number|null};

const hash=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
function copyDeclaration(d:AttemptDeclaration):AttemptDeclaration {
  if(!d || !hash(d.project_revision) || !hash(d.configuration_sha256) || !hash(d.runtime_lock_sha256))throw new Error('Invalid declarations');
  return Object.freeze({project_revision:d.project_revision,configuration_sha256:d.configuration_sha256,runtime_lock_sha256:d.runtime_lock_sha256});
}
function sameDeclaration(a:AttemptDeclaration,b:AttemptDeclaration) {
  return a.project_revision===b.project_revision && a.configuration_sha256===b.configuration_sha256 && a.runtime_lock_sha256===b.runtime_lock_sha256;
}
export function createAttemptHistory() {
  const rows:AttemptNote[]=[];
  function create(requested:number,input:AttemptDeclaration):string {
    if(!Number.isSafeInteger(requested) || requested<1 || requested>4096)throw new Error('Invalid step count');
    const declaration=copyDeclaration(input);
    if(rows.length>=32)throw new Error('Attempt history is full');
    const id=`local-${rows.length+1}`;
    rows.push({id,requested_ticks:requested,declaration,identity:null,status:'planned',last_verified_tick:null,reported_steps:null});
    return id;
  }
  function reserve(requested:number,input:AttemptDeclaration,identity:AttemptIdentity):string {
    const declaration=copyDeclaration(input);
    if(!identity || typeof identity.session_id!=='string' || !identity.session_id || identity.session_id.length>256 ||
       identity.project_revision!==declaration.project_revision || !Number.isSafeInteger(identity.run_epoch) || identity.run_epoch<0)throw new Error('Invalid attempt identity');
    let row=rows.find(x=>x.status==='planned' && x.requested_ticks===requested && sameDeclaration(x.declaration,declaration));
    if(!row) {const id=create(requested,declaration);row=rows.find(x=>x.id===id)!;}
    row.identity=Object.freeze({session_id:identity.session_id,project_revision:identity.project_revision,run_epoch:identity.run_epoch});
    row.status='running';return row.id;
  }
  function settle(id:string,status:Exclude<AttemptNoteStatus,'planned'|'running'>,verified:number|null,reported:number|null):void {
    const row=rows.find(x=>x.id===id);
    if(!row || row.status!=='running' || !['completed','cancelled','deadline','failed','unknown','unavailable'].includes(status) ||
       (verified!==null && (!Number.isSafeInteger(verified)||verified<0||verified>row.requested_ticks)) ||
       (reported!==null && (!Number.isSafeInteger(reported)||reported<0)) ||
       (status==='completed' && verified!==row.requested_ticks) || (status==='unavailable' && (verified!==null||reported!==null))) throw new Error('Invalid attempt outcome');
    row.status=status;row.last_verified_tick=verified;row.reported_steps=reported;
  }
  function snapshot() {
    const counts={missing:0,running:0,completed:0,cancelled:0,deadline:0,failed:0,unknown:0,unavailable:0};
    for(const row of rows)counts[row.status==='planned'?'missing':row.status]++;
    return {schema_version:1,provenance:'Session-observed attempt notes; user declarations are unverified; record is incomplete.',
      counts,rows:rows.map(row=>({id:row.id,requested_ticks:row.requested_ticks,declaration:{...row.declaration},
        identity:row.identity?{...row.identity}:null,status:row.status,last_verified_tick:row.last_verified_tick,reported_steps:row.reported_steps}))};
  }
  return Object.freeze({plan:create,reserve,settle,snapshot});
}

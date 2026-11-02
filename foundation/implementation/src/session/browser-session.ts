import {captureProjectInventory} from '../projects/project-inventory.ts';
import {captureProjectTargets} from '../projects/project-target-admission.ts';
import {encodeExactTargetHistory, inspectExactTargetHistory} from '../experiments/target-history-f64.ts';
import {safeProjectPath} from '../projects/project-path.ts';
import {createControlledProjectWorldManager, ResetFault, InspectionFault, OperationBusy, StepFault} from './project-world-manager.ts';
import {copyBounded, sameBoundedData} from './project-world-wire.ts';
import {channelStepBudget} from '../experiments/channel-step-budget.ts';
import {commandBatchBudget} from '../experiments/command-batch-budget.ts';
import {commandGroupLayout} from '../experiments/command-group-layout.ts';
import {microduckTruthDefinitionHash} from '../observations/microduck-truth-channel.ts';
import {validateTrustedRecordingPolicy} from './trusted-recording-policy.ts';
import {createDisplayRenderer} from '../display/three-display.ts';
import {createAttributedDisplayRenderer} from '../display/three-attributed-display.ts';
import {projectSceneGeometry} from '../display/scene-geometry-projection.ts';
import {joinMeshAttributes} from '../display/mesh-attribute-join.ts';

const CALLER_AUTHORITY = ['world','runner','runners','ports','MessagePort','owner_id',
  'lease_generation','run_epoch','session_id'] as const;

class DisplayCleanupFailure extends AggregateError {}
const canvasOwners = new WeakMap<object, object>();
const readBlob = Blob.prototype.arrayBuffer;

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key) &&
    !!Object.getOwnPropertyDescriptor(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) &&
    required.every(key => Object.hasOwn(value, key));
}

function rejectCallerAuthority(value: Record<string, any>, label: string) {
  for (const key of CALLER_AUTHORITY) if (Object.hasOwn(value, key)) {
    throw new Error(`Invalid ${label}: caller-supplied ${key}`);
  }
}

function freezeData<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) freezeData((value as any)[key]);
    Object.freeze(value);
  }
  return value;
}

function sameIdentity(a: any, b: any) {
  return !!a && !!b && a.session_id === b.session_id && a.project_revision === b.project_revision &&
    a.run_epoch === b.run_epoch;
}
function validSessionVisualFacts(model:any,frame:any): boolean {
  const count=(v:any)=>Number.isSafeInteger(v) && v>=0;
  const vector=(v:any,n:number)=>Array.isArray(v) && v.length===n && v.every((x:any)=>typeof x==='number' && Number.isFinite(x));
  const quaternion=(v:any)=>vector(v,4) && Math.abs(Math.hypot(...v)-1)<=1e-9;
  if(!exact(model,['engine_version','bodies','geoms']) || !exact(frame,['engine_version','tick','time','bodies']) ||
     model.engine_version!=='3.17.0' || frame.engine_version!=='3.17.0' || !count(frame.tick) ||
     typeof frame.time!=='number' || !Number.isFinite(frame.time) || frame.time<0 ||
     !Array.isArray(model.bodies) || model.bodies.length<1 || model.bodies.length>4096 ||
     !Array.isArray(frame.bodies) || frame.bodies.length!==model.bodies.length || !Array.isArray(model.geoms) || model.geoms.length>1024)return false;
  for(let id=0;id<model.bodies.length;id++) {
    const m=model.bodies[id],b=frame.bodies[id];
    if(!exact(m,['id','name','parent_id']) || m.id!==id || !(m.name===null || typeof m.name==='string') ||
       (id===0?m.parent_id!==null:!count(m.parent_id)||m.parent_id>=id) ||
       !exact(b,['id','position','quaternion']) || b.id!==id || !vector(b.position,3) || !quaternion(b.quaternion))return false;
  }
  for(let id=0;id<model.geoms.length;id++) {
    const g=model.geoms[id];
    if(!exact(g,['id','name','body_id','type','material_id','size','position','quaternion','rgba']) || g.id!==id ||
       !(g.name===null||typeof g.name==='string') || !count(g.body_id) || g.body_id>=model.bodies.length ||
       !['plane','hfield','sphere','capsule','ellipsoid','cylinder','box','mesh','sdf','unsupported'].includes(g.type) ||
       !(g.material_id===null||count(g.material_id)) || !vector(g.size,3) || g.size.some((v:number)=>v<0) ||
       !vector(g.position,3) || !quaternion(g.quaternion) || !vector(g.rgba,4) || g.rgba.some((v:number)=>v<0||v>1))return false;
  }
  return true;
}

type BrowserSession = {
  readonly identity: Readonly<{session_id: string; project_revision: string; run_epoch: number}>;
  readonly state: 'ready-paused' | 'running' | 'paused' | 'faulted' | 'disposed';
  readonly recordingChannels: readonly {group_id:string;channel_id:string;definition_sha256:string;max_entries:number;channel?:Readonly<Record<string,unknown>>;definition?:Readonly<Record<string,unknown>>;command_layout?:Readonly<Record<string,unknown>>}[];
  readonly targets: readonly Readonly<{group_id:string;field:string;min:number;max:number}>[];
  setTarget(request:unknown):Promise<unknown>;
  targetHistory():Readonly<{entries:readonly Readonly<Record<string,unknown>>[];truncated:boolean}>;
  captureTargetRecord():{id:string;encode:()=>Promise<Blob>;isCurrent:()=>boolean}|null;
  inspectTargetHistory(content:Blob,maxTick:number):Promise<unknown>;
  readonly assetNotices: readonly unknown[];
  submit(command: unknown): Promise<unknown>;
  acquireAttempt(): Promise<{step(steps:number):Promise<unknown>; setTarget(input:unknown):Promise<unknown>; cancel():Promise<void>; finish():Promise<void>}>;
  startBoundedAttempt(options: unknown): {result: Promise<unknown>; cancel(): Promise<void>};
  startMeasuredAttempt(options: unknown): {result: Promise<unknown>; cancel(): Promise<void>};
  beginVisualMeshRead(): {result: Promise<unknown>; cancel(): Promise<void>};
  beginVisualMeshAttributeRead(): {result: Promise<unknown>; cancel(): Promise<void>};
  beginPartialSceneRead(input:unknown): {result:Promise<unknown>;cancel():Promise<void>};
  beginAttributedSceneRead(input:unknown): {result:Promise<unknown>;cancel():Promise<void>};
  inspect(): Promise<unknown>;
  readVisual(): Promise<unknown>;
  readVisualFacts(): Promise<unknown>;
  listenSchematicFrames(callback:(value:unknown)=>void):()=>void;
  readVisualGroups(): Promise<unknown>;
  attachDisplay(canvas: HTMLCanvasElement, options: {width:number;height:number}): Promise<unknown>;
  attachAttributedDisplay(canvas: HTMLCanvasElement, options: {width:number;height:number;visibility:boolean[]}): Promise<unknown>;
  dispose(): Promise<void>;
};

function makeHost(manager: any, identity: any, budget: number, assetNotices: readonly unknown[], recordingChannels:readonly any[], targets:BrowserSession['targets'], sourceInventory:any, targetControllers:unknown): BrowserSession {
  let state: BrowserSession['state'] = 'ready-paused';
  let attemptOwner: object | null = null, activeCommands = 0;
  let targetPending: Promise<unknown> | null = null;
  const targetEntries:Readonly<Record<string,unknown>>[]=[];let targetTruncated=false,targetVersion=0;const targetRecordId='session-targets-'+crypto.randomUUID();
  function targetHistory() {return Object.freeze({entries:Object.freeze(targetEntries.slice()),truncated:targetTruncated});}
  function recordTarget(identity:any,request:any,status:'accepted'|'rejected'|'unknown',reply?:any) {
    targetVersion++;
    if(targetEntries.length>=4096){targetTruncated=true;return;}
    targetEntries.push(freezeData({identity:copyBounded(identity,budget),group_id:request.group_id,field:request.field,value:request.value,status,tick:status==='accepted'?reply.tick:null,lease_generation:status==='accepted'?reply.lease_generation:null}));
  }
  async function inspectTargetHistory(content:Blob,maxTick:number) {
    if(isDisposed())throw Error('Session disposed');
    const identity=current;
    const result=await inspectExactTargetHistory(sourceInventory,targetControllers,content,maxTick);
    if(isDisposed()||!sameIdentity(current,identity))throw Error('Session changed during target inspection');
    return result;
  }
  function captureTargetRecord(){
    if(isDisposed())throw Error('Session disposed');if(targetPending)throw Error('Target operation pending');
    if(!targetEntries.length&&!targetTruncated)return null;
    const version=targetVersion,identity=current,snapshot=targetHistory();
    return Object.freeze({id:targetRecordId,encode:()=>encodeExactTargetHistory(sourceInventory,targetControllers,snapshot,Number.MAX_SAFE_INTEGER),
      isCurrent:()=>!isDisposed()&&!targetPending&&targetVersion===version&&sameIdentity(identity,current)});
  }
  type StateOwner = {state: BrowserSession['state']};
  let stateOwner: StateOwner = {state};
  function publish(owner: StateOwner, next: BrowserSession['state']) {
    owner.state = next;
    if (stateOwner === owner && state !== 'disposed' && state !== 'faulted') state = next;
  }
  let disposal: Promise<void> | null = null;
  const isDisposed = () => state === 'disposed';
  const isFaulted = () => state === 'faulted';
  let current = freezeData(copyBounded(identity, budget));
  const views = new Set<{detach: () => Promise<void>}>();
  const schematicStops=new Set<()=>void>();
  const reservedCanvases = new Set<HTMLCanvasElement>();
  const canvasOwner = Object.freeze({});
  let presentationGeneration = 0;
  let meshJob: {cancel:()=>Promise<void>} | null = null;
  let sceneJob: {cancel:()=>Promise<void>} | null = null;
  let attributedJob: {cancel:()=>Promise<void>} | null = null;
  function releaseCanvas(canvas: HTMLCanvasElement) {
    reservedCanvases.delete(canvas);
    if (canvasOwners.get(canvas) === canvasOwner) canvasOwners.delete(canvas);
  }
  function invalidatePresentation() {
    if (!Number.isSafeInteger(presentationGeneration + 1)) throw new Error('Display generation exhausted');
    presentationGeneration++;
    for (const canvas of reservedCanvases) canvas.hidden = true;
  }
  const displayTasks = new Set<Promise<unknown>>();
  const displayCleanupFailures: unknown[] = [];
  let displayDrawing = 0;
  async function draw(renderer:any, snapshot:unknown): Promise<void> {
    displayDrawing++;
    try {await renderer.render(snapshot);} finally {displayDrawing--;}
  }
  function track<T>(task: Promise<T>): Promise<T> {
    displayTasks.add(task);
    void task.then(() => displayTasks.delete(task), () => displayTasks.delete(task));
    return task;
  }

  function commandIdentity(command: Record<string, any>) {
    if (typeof command.session_id !== 'string' || typeof command.project_revision !== 'string' ||
        !Number.isSafeInteger(command.run_epoch) || command.run_epoch < 0) throw new Error('Invalid session command identity');
    if (!sameIdentity(command, current)) throw new Error('Stale session identity');
  }

  async function execute(input: unknown, owner: object | null, recording?: any): Promise<unknown> {
    if (state === 'disposed') throw new Error('Session disposed');
    if (!exact(input, ['kind', 'session_id', 'project_revision', 'run_epoch'], ['steps'])) throw new Error('Invalid session command');
    const kind = input.kind;
    commandIdentity(input);
    if (kind === 'dispose') { await dispose(); return undefined; }
    if(targetPending)throw new OperationBusy('Target operation is busy');
    if (attemptOwner !== owner) throw new Error('Attempt control is busy or closed');
    activeCommands++;
    try {
    if (displayDrawing && (kind === 'step' || kind === 'run' || kind === 'reset')) throw new Error('Display operation in progress');
    if (kind === 'reset') {
      if (!exact(input, ['kind', 'session_id', 'project_revision', 'run_epoch'])) throw new Error('Invalid session command');
      invalidatePresentation();
      if(attributedJob)await attributedJob.cancel();
      if(sceneJob)await sceneJob.cancel();
      if(meshJob)await meshJob.cancel();
      if(isDisposed())throw new Error('Session disposed');
      const previous = current;
      let result: any;
      try { result = await manager.reset({identity: previous}); }
      catch (error) { if (!isDisposed() && error instanceof ResetFault) state = 'faulted'; throw error; }
      if (isDisposed()) return result;
      if (!exact(result, ['identity']) || !exact(result.identity, ['session_id', 'project_revision', 'run_epoch']) ||
          result.identity.session_id !== previous.session_id || result.identity.project_revision !== previous.project_revision ||
          !Number.isSafeInteger(previous.run_epoch + 1) || result.identity.run_epoch !== previous.run_epoch + 1) {
        throw new Error('Invalid reset identity');
      }
      current = freezeData(copyBounded(result.identity, budget));
      state = 'ready-paused';
      stateOwner = {state};
      return result;
    }
    if (kind === 'step') {
      if (!exact(input, ['kind', 'session_id', 'project_revision', 'run_epoch', 'steps']) ||
          !Number.isSafeInteger(input.steps) || input.steps < 1 || input.steps > 64) throw new Error('Invalid session command');
    } else if (kind === 'run' || kind === 'pause') {
      if (!exact(input, ['kind', 'session_id', 'project_revision', 'run_epoch'])) throw new Error('Invalid session command');
    } else throw new Error('Invalid session command');
    if (kind === 'run' && state === 'running') throw new Error('Session already running');
    if (kind === 'step' || kind === 'run') invalidatePresentation();
    try {
      if (kind === 'step') {
        const owner = stateOwner;
        let result: unknown;
        try { result = recording ? await manager.stepMeasured({identity: current, steps: input.steps,...recording}) : await manager.step({identity: current, steps: input.steps}); }
        catch (error) { if (!isDisposed() && error instanceof StepFault) state = 'faulted'; throw error; }
        publish(owner, 'ready-paused');
        return result;
      }
      if (kind === 'run') {
        const priorOwner = stateOwner;
        const owner: StateOwner = {state:'running'};
        stateOwner = owner;
        state = 'running';
        try {
          const result = await manager.run({identity: current});
          publish(owner, 'paused');
          return result;
        } catch (error) {
          if (!isDisposed()) {
            if (error instanceof OperationBusy) {
              if (stateOwner === owner && !isFaulted()) { stateOwner = priorOwner; state = priorOwner.state; }
            } else state = 'faulted';
          }
          throw error;
        }
      }
      const owner = stateOwner;
      const result = await manager.pause({identity: current});
      publish(owner, 'paused');
      return result;
    } catch (error) {
      throw error;
    }
    } finally { activeCommands--; }
  }

  function submit(input: unknown): Promise<unknown> { return execute(input, null); }

  function setTarget(input: unknown): Promise<unknown> { return setTargetCore(input,null); }

  function setTargetCore(input: unknown, owner: object | null): Promise<unknown> {
    if (isDisposed()) return Promise.reject(new Error('Session disposed'));
    if (isFaulted()) return Promise.reject(new Error('Session faulted'));
    if ((state !== 'ready-paused' && state !== 'paused') || attemptOwner !== owner || activeCommands || targetPending || meshJob || sceneJob || attributedJob || displayDrawing || displayTasks.size) return Promise.reject(new Error('Session operation is busy or not paused'));
    let request: any;
    try {
      request = copyBounded(input, 4096);
      if (!exact(request,['group_id','field','value']) || typeof request.group_id !== 'string' || !request.group_id || request.group_id.length > 256 ||
          typeof request.field !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(request.field) ||
          typeof request.value !== 'number' || !Number.isFinite(request.value)) throw new Error('Invalid target request');
    } catch (error) { return Promise.reject(error); }
    const identity = current;
    let dispatched = false;
    const task = (async () => {
      try {
        await Promise.resolve();
        if (isDisposed()) throw new Error('Session disposed');
        dispatched = true;
        const reply = copyBounded(await manager.setTarget({identity,group_id:request.group_id,field:request.field,value:request.value}), budget);
        if (isDisposed()) throw new Error('Session disposed');
        if (!sameIdentity(current,identity) || !exact(reply?.identity,['session_id','project_revision','run_epoch']) || !sameIdentity(reply.identity,identity) ||
            reply.group_id !== request.group_id || reply.field !== request.field || !Object.is(reply.value,request.value)) throw new Error('Invalid target response');
        if (reply.status === 'accepted') {
          if (!exact(reply,['status','identity','group_id','field','value','lease_generation','tick']) ||
              !Number.isSafeInteger(reply.lease_generation) || reply.lease_generation < 1 || !Number.isSafeInteger(reply.tick) || reply.tick < 0) throw new Error('Invalid target acceptance');
        } else if (reply.status === 'rejected') {
          if (!exact(reply,['status','identity','group_id','field','value','reason']) || reply.reason !== 'not_permitted') throw new Error('Invalid target rejection');
        } else throw new Error('Invalid target outcome');
        recordTarget(identity,request,reply.status,reply);
        return freezeData(reply);
      } catch (error) {
        if(error instanceof OperationBusy)dispatched=false;
        if (dispatched) recordTarget(identity,request,'unknown');
        if (dispatched && !isDisposed()) state = 'faulted';
        throw error;
      }
    })();
    targetPending = task;
    void task.then(() => {if (targetPending === task) targetPending = null;}, () => {if (targetPending === task) targetPending = null;});
    return task;
  }

  function acquireAttemptCore(recording?: any): Promise<{step(steps:number):Promise<unknown>; setTarget(input:unknown):Promise<unknown>; cancel():Promise<void>; finish():Promise<void>}> {
    if (state === 'disposed') return Promise.reject(new Error('Session disposed'));
    if (state === 'faulted') return Promise.reject(new Error('Session faulted'));
    if (state !== 'ready-paused' && state !== 'paused') return Promise.reject(new Error('Session is not paused'));
    if (attemptOwner || activeCommands || targetPending) return Promise.reject(new Error('Session operation is busy'));
    const owner = Object.freeze({}), identity = current;
    attemptOwner = owner;
    let closed = false, active: Promise<unknown> | null = null, closing: Promise<void> | null = null;
    const release = () => { if (attemptOwner === owner) attemptOwner = null; };
    const finish = (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      const pending = active;
      closing = pending ? pending.then(() => { release(); }, () => { release(); }) : Promise.resolve().then(release);
      return closing;
    };
    const step = (steps:number): Promise<unknown> => {
      if (closed || state === 'disposed' || attemptOwner !== owner) return Promise.reject(new Error('Attempt is closed'));
      if (state === 'faulted') return Promise.reject(new Error('Session faulted'));
      if (active) return Promise.reject(new Error('Attempt step is busy'));
      let resolve!: (value:unknown)=>void, reject!: (reason:unknown)=>void;
      const task = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
      active = task;
      void task.then(() => { if (active === task) active = null; }, () => {
        if (active === task) active = null;
        closed = true;
        release();
      });
      void execute({kind:'step', ...identity, steps}, owner, recording).then(resolve, reject);
      return task;
    };
    const setLeaseTarget = (input:unknown): Promise<unknown> => {
      if(closed || state==='disposed' || attemptOwner!==owner)return Promise.reject(new Error('Attempt is closed'));
      if(state==='faulted')return Promise.reject(new Error('Session faulted'));
      if(active)return Promise.reject(new Error('Attempt operation is busy'));
      let resolve!: (value:unknown)=>void, reject!: (reason:unknown)=>void;
      const task=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no});
      active=task;
      void task.then(()=>{if(active===task)active=null;},()=>{if(active===task)active=null;closed=true;release();});
      void setTargetCore(input,owner).then(resolve,reject);
      return task;
    };
    return Promise.resolve(Object.freeze({step, setTarget:setLeaseTarget, cancel:finish, finish}));
  }

  function acquireAttempt() { return acquireAttemptCore(); }
  function startMeasuredAttempt(input: unknown): {result: Promise<unknown>; cancel(): Promise<void>} {
    if (!exact(input,['requested_ticks','batch_size','max_wall_ms','configuration_evidence','measurement'])) throw new Error('Invalid measured attempt');
    const value:any=copyBounded(input,budget), choice=value.measurement;
    if (!exact(choice,['group_id','channel_id','definition_sha256']) ||
        typeof choice.group_id!=='string' || !choice.group_id || choice.group_id.length>256 ||
        typeof choice.channel_id!=='string' || !choice.channel_id || choice.channel_id.length>256 ||
        typeof choice.definition_sha256!=='string' || !/^[0-9a-f]{64}$/.test(choice.definition_sha256) ||
        !Number.isSafeInteger(value.requested_ticks) || value.requested_ticks<1 || value.requested_ticks>256) throw new Error('Invalid measured attempt');
    const recording={...choice,attempt_token:crypto.randomUUID()};
    const approved=recordingChannels.find(row=>row.group_id===choice.group_id && row.channel_id===choice.channel_id && row.definition_sha256===choice.definition_sha256);
    return startAttempt({requested_ticks:value.requested_ticks,batch_size:value.batch_size,max_wall_ms:value.max_wall_ms,configuration_evidence:value.configuration_evidence},recording,approved?.channel ? approved : undefined);
  }
  function startBoundedAttempt(input: unknown) { return startAttempt(input); }
  function startAttempt(input: unknown, recording?: any, channelPolicy?: any): {result: Promise<unknown>; cancel(): Promise<void>} {
    function snapshotFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Invalid attempt options');
      const actual = Reflect.ownKeys(value);
      if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('Invalid attempt options');
      const copy: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid attempt options');
        copy[key] = descriptor.value;
      }
      return copy;
    }
    const outer = snapshotFields(input, ['requested_ticks','batch_size','max_wall_ms','configuration_evidence']);
    const requested = outer.requested_ticks, batchSize = outer.batch_size, wall = outer.max_wall_ms;
    const evidence = snapshotFields(outer.configuration_evidence, ['project_revision','configuration_sha256','runtime_lock_sha256']);
    if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1 ||
        typeof batchSize !== 'number' || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64 ||
        typeof wall !== 'number' || !Number.isFinite(wall) || wall < 0) throw new Error('Invalid attempt options');
    for (const key of ['project_revision','configuration_sha256','runtime_lock_sha256']) {
      if (typeof evidence[key] !== 'string' || !/^[a-f0-9]{64}$/.test(evidence[key])) throw new Error('Invalid attempt declaration');
    }
    if (evidence.project_revision !== current.project_revision) throw new Error('Attempt project mismatch');
    const declaration = Object.freeze({project_revision:evidence.project_revision, configuration_sha256:evidence.configuration_sha256,
      runtime_lock_sha256:evidence.runtime_lock_sha256});
    const identity = freezeData(copyBounded(current, budget));
    let effectiveBatchSize=batchSize;
    if(channelPolicy) {
      // Bound against worst-case numeric identifiers and the current authority;
      // the manager and Worker independently recheck the actual message.
      effectiveBatchSize=Math.min(batchSize,channelPolicy.max_entries);
      const authority={...identity,group_id:recording.group_id,lease_generation:Number.MAX_SAFE_INTEGER,
        channel_id:recording.channel_id,definition_sha256:recording.definition_sha256};
      while(effectiveBatchSize>0) {
        try {channelStepBudget({request_id:'00000000-0000-4000-8000-000000000000',generation:Number.MAX_SAFE_INTEGER,
          command_sequence:Number.MAX_SAFE_INTEGER,identity,start_tick:requested-1,steps:effectiveBatchSize,
          attempt_token:recording.attempt_token,authority},channelPolicy.channel);
          commandBatchBudget({...identity,group_id:recording.group_id,lease_generation:Number.MAX_SAFE_INTEGER},channelPolicy.command_layout,requested-1,effectiveBatchSize);break;}
        catch {effectiveBatchSize--;}
      }
      if(effectiveBatchSize===0)throw Error('Recording channel exceeds response budget');
    }
    const started = performance.now();
    let cancelled = false;
    // Acquire synchronously before yielding to caller code or inspection.
    const acquisition = acquireAttemptCore(recording);
    const result = (async () => {
      let lease: Awaited<ReturnType<typeof acquireAttempt>> | undefined;
      let status: 'completed'|'cancelled'|'deadline'|'failed'|'unknown' = 'failed';
      let verified: number | null = null, reported: number | null = null;
      let primary: unknown, hasPrimary = false, operationError: unknown, hasOperationError = false;
      const entries:any[]=[]; let authority:any=null;
      try {
        try { lease = await acquisition; }
        catch { return freezeData({status, identity, configuration_evidence:declaration, requested_ticks:requested, last_verified_tick:verified, reported_steps:reported,...(recording ? {measurement:{authority:null,entries:[],complete:false,...(channelPolicy ? {channel:channelPolicy.channel,...(channelPolicy.definition ? {definition:channelPolicy.definition} : {})} : {})}} : {})}); }
        try {
          let first: any;
          try { first = await inspect(); }
          catch (error) { first = null; operationError = error; hasOperationError = true; }
          if (first && !isDisposed() && sameIdentity(current, identity) && sameIdentity(first.identity, identity) && first.plant?.tick === 0) {
            verified = 0;
            while (verified < requested) {
              if (isDisposed() || !sameIdentity(current, identity)) {status = 'unknown'; break;}
              if (cancelled) {status = 'cancelled'; break;}
              if (performance.now() - started >= wall) {status = 'deadline'; break;}
              const steps = Math.min(effectiveBatchSize, requested - verified);
              let response: any;
              try { response = await lease.step(steps); }
              catch (error) {
                operationError = error; hasOperationError = true;
                try {
                  const field = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'steps_completed') : undefined;
                  if (field && Object.hasOwn(field, 'value') && Number.isSafeInteger(field.value) && field.value >= 0 && field.value <= steps) reported = field.value;
                } catch { /* Error metadata is optional and cannot certify a step. */ }
                status = 'unknown'; break;
              }
              if (isDisposed() || !sameIdentity(current, identity) || !sameIdentity(response?.identity, identity) ||
                  !sameIdentity(response?.inspection?.identity, identity) || response?.steps_completed !== steps ||
                  !Number.isSafeInteger(response?.inspection?.plant?.tick) || response.inspection.plant.tick !== verified + steps) {
                status = 'unknown'; break;
              }
              if (recording) {
                const log=response.measurement, a=log?.authority;
                if ((channelPolicy && !sameBoundedData(response.measurement_channel,channelPolicy.channel)) ||
                    !a || !sameIdentity(a,identity) || a.group_id!==recording.group_id || a.channel_id!==recording.channel_id ||
                    a.definition_sha256!==recording.definition_sha256 || !Number.isSafeInteger(a.lease_generation) || a.lease_generation<1 ||
                    (authority && a.lease_generation!==authority.lease_generation) || !Array.isArray(log.entries) || log.entries.length!==steps ||
                    log.sealed!==false || log.complete!==false || log.entries.some((entry:any,index:number)=>entry?.observed_tick!==verified!+index || entry?.outcome!=='completed')) {
                  status='unknown'; break;
                }
                authority=copyBounded(a,budget);
                entries.push(...copyBounded(log.entries,budget));
              }
              verified += steps;
              if (cancelled) {status = 'cancelled'; break;}
              if (verified === requested) {status = 'completed'; break;}
            }
          }
        } catch (error) { primary = error; hasPrimary = true; }
      } finally {
        if (lease) {
          try { await lease.finish(); }
          catch (error) {
            if (hasPrimary || hasOperationError) throw new AggregateError([hasPrimary ? primary : operationError,error], 'Attempt and cleanup failed');
            throw error;
          }
        }
      }
      if (hasPrimary) throw primary;
      return freezeData({status, identity, configuration_evidence:declaration, requested_ticks:requested, last_verified_tick:verified, reported_steps:reported,
        ...(recording ? {measurement:{authority,entries,complete:status==='completed' && entries.length===requested,...(channelPolicy ? {channel:channelPolicy.channel,...(channelPolicy.definition ? {definition:channelPolicy.definition} : {})} : {})}} : {})});
    })();
    return Object.freeze({result, cancel() {cancelled = true; return result.then(() => undefined);}});
  }

  async function inspect(): Promise<unknown> {
    if (isDisposed()) throw new Error('Session disposed');
    if (state !== 'ready-paused' && state !== 'paused') throw new Error('Session inspection unavailable');
    const identity = current;
    let value:any;
    try { value = await manager.inspectActive(); }
    catch (error) { if (!isDisposed() && error instanceof InspectionFault) state = 'faulted'; throw error; }
    if (isDisposed()) throw new Error('Session disposed');
    if (!sameIdentity(current, identity) || !sameIdentity(value?.identity, identity)) throw new Error('Stale session inspection');
    return copyBounded(value, budget);
  }

  async function readVisual(): Promise<unknown> {
    if (isDisposed()) throw new Error('Session disposed');
    if (state !== 'ready-paused' && state !== 'paused') throw new Error('Session visual inspection unavailable');
    const identity=current;
    let value:any;
    try {value=await manager.readVisualActive();}
    catch(error) {if(!isDisposed() && error instanceof InspectionFault)state='faulted';throw error;}
    if(isDisposed())throw new Error('Session disposed');
    if(!sameIdentity(current,identity)||!sameIdentity(value?.identity,identity))throw new Error('Stale session visual inspection');
    return copyBounded(value,budget);
  }

  async function readVisualGroups(): Promise<unknown> {
    if (isDisposed()) throw new Error('Session disposed');
    if (state !== 'ready-paused' && state !== 'paused') throw new Error('Session visual groups unavailable');
    const identity=current;
    const raw=await manager.readVisualGroupsActive();
    if ((state !== 'ready-paused' && state !== 'paused') || !sameIdentity(current,identity)) throw new Error('Stale session visual groups');
    const value:any=copyBounded(raw,budget);
    if (!exact(value?.identity,['session_id','project_revision','run_epoch']) || !sameIdentity(value.identity,identity)) throw new Error('Stale session visual groups');
    if (exact(value,['identity','status','groups']) && value.status==='available' && Array.isArray(value.groups) &&
        value.groups.length<=1024 && value.groups.every((group:any)=>Number.isInteger(group) && group>=-2147483648 && group<=2147483647)) {
      return {identity:freezeData(value.identity),status:'available',groups:value.groups};
    }
    if (exact(value,['identity','status','reason']) && value.status==='unavailable' && value.reason==='capacity') {
      return {identity:freezeData(value.identity),status:'unavailable',reason:'capacity'};
    }
    throw new Error('Invalid session visual groups');
  }
  async function readVisualFacts(): Promise<unknown> {
    if(isDisposed())throw new Error('Session disposed');
    if(state!=='ready-paused' && state!=='paused')throw new Error('Session visual facts unavailable');
    const identity=current,version=presentationGeneration;
    const raw=await manager.readVisualFactsActive();
    if((state!=='ready-paused' && state!=='paused') || version!==presentationGeneration || !sameIdentity(current,identity))throw new Error('Stale session visual facts');
    const value:any=copyBounded(raw,budget);
    if(!exact(value?.identity,['session_id','project_revision','run_epoch']) || !sameIdentity(value.identity,identity))throw new Error('Stale session visual facts');
    if(exact(value,['identity','status','reason']) && value.status==='unavailable' && value.reason==='capacity')
      return {identity:freezeData(value.identity),status:'unavailable',reason:'capacity'};
    const required=['groups','mesh-data','sites','materials','textures','skybox','lighting','mesh-normals','uvs'];
    if(!exact(value,['identity','status','model','frame','limitations']) || value.status!=='partial' ||
       !Array.isArray(value.limitations) || value.limitations.length!==required.length ||
       !required.every(item=>value.limitations.includes(item)) || !validSessionVisualFacts(value.model,value.frame))throw new Error('Invalid session visual facts');
    value.identity=freezeData(value.identity);
    return value;
  }

  function listenSchematicFrames(callback:(value:unknown)=>void):()=>void {
    if(isDisposed()||isFaulted()||(state!=='ready-paused'&&state!=='paused')||typeof callback!=='function')throw Error('Schematic stream unavailable');
    const identity=current;let live=true;
    const detach=manager.attachPoseSink({identity},(value:any)=>{if(!live||isDisposed()||isFaulted()||state!=='running'||!sameIdentity(current,identity))return;callback(value);});
    const stop=()=>{if(!live)return;live=false;schematicStops.delete(stop);detach();};schematicStops.add(stop);return stop;
  }
  function attachDisplay(canvas: HTMLCanvasElement, options: {width:number;height:number}): Promise<unknown> {
    if (isDisposed()) return Promise.reject(new Error('Session disposed'));
    if (!canvas || (typeof canvas !== 'object' && typeof canvas !== 'function')) return Promise.reject(new Error('Invalid display canvas'));
    if (canvasOwners.has(canvas)) return Promise.reject(new Error('Canvas already attached'));
    if (reservedCanvases.size >= 4) return Promise.reject(new Error('Display limit exceeded'));
    canvasOwners.set(canvas, canvasOwner); reservedCanvases.add(canvas);
    try { canvas.hidden = true; } catch (error) { releaseCanvas(canvas); return Promise.reject(error); }
    const version = presentationGeneration;
    return track((async () => {
      let renderer: Awaited<ReturnType<typeof createDisplayRenderer>> | null = null;
      let visual:any;
      try {
        visual = await readVisual();
        if (visual.status !== 'available') {releaseCanvas(canvas); return visual;}
        const frameIdentity = visual.identity;
        renderer = await createDisplayRenderer(canvas, options);
        if (isDisposed()) throw new Error('Session disposed during display attachment');
        if (version !== presentationGeneration || !sameIdentity(current, frameIdentity)) throw new Error('Stale display epoch');
        await draw(renderer, visual.snapshot);
        if (isDisposed()) throw new Error('Session disposed during display attachment');
        if (version !== presentationGeneration || !sameIdentity(current, frameIdentity)) throw new Error('Stale display epoch');
        canvas.hidden = false;
      } catch (error) {
        canvas.hidden = true;
        if (renderer) try { await renderer.dispose(); } catch (failure) { const cleanup = new DisplayCleanupFailure([error, failure], 'Display attachment cleanup failed'); displayCleanupFailures.push(cleanup); throw cleanup; }
        releaseCanvas(canvas);
        throw error;
      }
      const frameIdentity = visual.identity;
      let closed = false, retired = false, pending: Promise<unknown> | null = null, closing: Promise<void> | null = null;
      const view = Object.freeze({
        get retired() {return retired;},
        refresh(): Promise<unknown> {
          if (closed || isDisposed()) return Promise.reject(new Error('Display or session disposed'));
          if (pending) return Promise.reject(new Error('Display refresh in progress'));
          const version = presentationGeneration;
          const job = (async () => {
            const next:any = await readVisual();
            if (closed || isDisposed()) throw new Error('Display or session disposed');
            if (version !== presentationGeneration) throw new Error('Stale display epoch');
            if (next.status !== 'available') {
              closed = true;
              canvas.hidden = true;
              closing = renderer.dispose();
              try { await closing; } catch (failure) { const cleanup = new DisplayCleanupFailure([failure], 'Display cleanup failed'); displayCleanupFailures.push(cleanup); throw cleanup; }
              views.delete(view); releaseCanvas(canvas); retired=true;
              return next;
            }
            if (version !== presentationGeneration || !sameIdentity(current, next.identity)) throw new Error('Stale display epoch');
            try { await draw(renderer, next.snapshot); }
            catch (error) {
              closed = true; canvas.hidden = true;
              closing = renderer.dispose();
              try { await closing; } catch (failure) { const cleanup = new DisplayCleanupFailure([error, failure], 'Display refresh cleanup failed'); displayCleanupFailures.push(cleanup); throw cleanup; }
              views.delete(view); releaseCanvas(canvas); retired=true;
              throw error;
            }
            if (closed || isDisposed()) throw new Error('Display or session disposed');
            if (version !== presentationGeneration || !sameIdentity(current, next.identity)) throw new Error('Stale display epoch');
            canvas.hidden = false;
            return {identity: next.identity, status:'available', tick:next.snapshot.tick, time:next.snapshot.time};
          })();
          pending = job;
          void job.then(() => {if (pending === job) pending = null;}, () => {if (pending === job) pending = null;});
          return track(job);
        },
        detach(): Promise<void> {
          if (closing) return closing;
          closed = true;
          canvas.hidden = true;
          const job = (async () => {
            if (pending) await pending.catch(() => {});
            await renderer.dispose();
            views.delete(view); releaseCanvas(canvas); retired=true;
          })();
          closing = job;
          return job;
        },
      });
      views.add(view);
      return {identity: frameIdentity, status:'available', view};
    })());
  }

  function attachAttributedDisplay(canvas:HTMLCanvasElement, input:unknown):Promise<unknown> {
    if(isDisposed())return Promise.reject(new Error('Session disposed'));
    if(!canvas || (typeof canvas!=='object' && typeof canvas!=='function'))return Promise.reject(new Error('Invalid display canvas'));
    let options:any;
    try {
      if(!exact(input,['width','height','visibility']))throw Error('Invalid display options');
      options=copyBounded(input,budget);
      if(!Number.isSafeInteger(options.width) || !Number.isSafeInteger(options.height) || options.width<1 || options.height<1 ||
         options.width>2048 || options.height>2048 || !Array.isArray(options.visibility) || options.visibility.length!==6 ||
         !options.visibility.every((x:any)=>typeof x==='boolean'))throw Error('Invalid display options');
    } catch(error){return Promise.reject(error);}
    if(canvasOwners.has(canvas))return Promise.reject(new Error('Canvas already attached'));
    if(reservedCanvases.size>=4)return Promise.reject(new Error('Display limit exceeded'));
    canvasOwners.set(canvas,canvasOwner);reservedCanvases.add(canvas);
    try{canvas.hidden=true;}catch(error){releaseCanvas(canvas);return Promise.reject(error);}
    const identity=current,version=presentationGeneration;
    const valid=(generation:number)=>!isDisposed() && !isFaulted() && (state==='ready-paused' || state==='paused') &&
      generation===presentationGeneration && sameIdentity(identity,current);
    return track((async()=>{
      let renderer:any=null;
      try {
        const sceneRead=beginAttributedSceneRead({visibility:options.visibility});
        const scene:any=await sceneRead.result;
        if(!valid(version) || !sameIdentity(identity,scene.identity))throw Error('Stale display epoch');
        renderer=await createAttributedDisplayRenderer(canvas,{width:options.width,height:options.height});
        if(!valid(version))throw Error('Stale display epoch');
        await draw(renderer,scene);
        if(!valid(version))throw Error('Stale display epoch');
        canvas.hidden=false;
      } catch(error) {
        canvas.hidden=true;
        if(renderer)try{await renderer.dispose();}catch(failure){const cleanup=new DisplayCleanupFailure([error,failure],'Display attachment cleanup failed');displayCleanupFailures.push(cleanup);throw cleanup;}
        releaseCanvas(canvas);throw error;
      }
      const limitations=Object.freeze([...renderer.limitations]);
      let closed=false,retired=false,pending:Promise<unknown>|null=null,closing:Promise<void>|null=null;
      let read:{cancel:()=>Promise<void>}|null=null,drawing:Promise<void>|null=null;
      const view=Object.freeze({
        get retired(){return retired;},
        refresh():Promise<unknown>{
          if(closed || isDisposed())return Promise.reject(Error('Display or session disposed'));
          if(pending)return Promise.reject(Error('Display refresh in progress'));
          const generation=presentationGeneration;
          if(!sameIdentity(identity,current))return view.detach().then(()=>{throw Error('Stale display epoch');});
          const job=(async()=>{
            try {
              let install!:(value:{result:Promise<unknown>;cancel:()=>Promise<void>})=>void,fail!:(error:unknown)=>void;
              const ready=new Promise<{result:Promise<unknown>;cancel:()=>Promise<void>}>((resolve,reject)=>{install=resolve;fail=reject;});
              void ready.catch(()=>{});read={cancel:()=>ready.then(value=>value.cancel())};
              let sceneRead:{result:Promise<unknown>;cancel:()=>Promise<void>};
              try{sceneRead=beginAttributedSceneRead({visibility:options.visibility});install(sceneRead);read=sceneRead;}catch(error){fail(error);throw error;}
              const scene:any=await sceneRead.result;read=null;
              if(closed || !valid(generation) || !sameIdentity(identity,scene.identity))throw Error('Stale display epoch');
              const drawJob=Promise.resolve().then(()=>{if(closed)throw Error('Display disposed');return draw(renderer,scene);});
              drawing=drawJob;try{await drawJob;}finally{if(drawing===drawJob)drawing=null;}
              if(closed || !valid(generation))throw Error('Stale display epoch');
              canvas.hidden=false;return {status:'partial',identity:scene.identity,tick:scene.tick,time:scene.time,limitations};
            } catch(error) {canvas.hidden=true;throw error;}
          })();
          pending=job;void job.then(()=>{if(pending===job)pending=null;},()=>{if(pending===job)pending=null;});return track(job);
        },
        detach():Promise<void>{
          if(closing)return closing;closed=true;canvas.hidden=true;
          closing=Promise.resolve().then(async()=>{
            const activeRead=read,activeDraw=drawing;
            const cancelTask=activeRead ? Promise.resolve().then(()=>activeRead.cancel()) : Promise.resolve();
            const disposeTask=Promise.resolve().then(async()=>{if(activeDraw)await activeDraw.catch(()=>{});await renderer.dispose();});
            const results=await Promise.allSettled([cancelTask,disposeTask]),failures:unknown[]=[];
            for(const item of results)if(item.status==='rejected')failures.push(item.reason);
            if(failures.length){const cleanup=new DisplayCleanupFailure(failures,'Display cleanup failed');displayCleanupFailures.push(cleanup);throw cleanup;}
            views.delete(view);releaseCanvas(canvas);retired=true;
          });return closing;
        },
      });
      views.add(view);return {status:'partial',identity,limitations,view};
    })());
  }

  function beginBinaryPresentationRead(attributes:boolean, internal=false): {result:Promise<unknown>;cancel:()=>Promise<void>} {
    if(state!=='ready-paused' && state!=='paused')throw new Error('Mesh read requires a paused session');
    if(attributedJob && !internal)throw new Error('Scene read in progress');
    const read=attributes ? manager.beginVisualMeshAttributeRead : manager.beginVisualMeshRead;
    if(meshJob || typeof read!=='function')throw new Error('Mesh read unavailable');
    const identity=current, token=presentationGeneration;
    let cancelled=false, resultSettled=false, cancellation:Promise<void>|null=null, cancellationSucceeded=false;
    let install!:(value:any)=>void, failInstall!:(reason:unknown)=>void;
    const installed=new Promise<any>((resolve,reject)=>{install=resolve;failInstall=reject;});
    void installed.catch(()=>{});
    const release=()=>{if(resultSettled && (!cancellation || cancellationSucceeded) && meshJob===owner)meshJob=null;};
    const cancel=()=>{
      if(resultSettled && !cancellation)return Promise.resolve();
      cancelled=true;
      if(!cancellation){
        cancellation=installed.then(inner=>inner.cancel()).then(()=>{cancellationSucceeded=true;release();});
        void cancellation.catch(()=>{});
      }
      return cancellation;
    };
    const owner={cancel};meshJob=owner;
    let inner:any;
    try {
      inner=read.call(manager,{identity});
      if(!inner || !(inner.result instanceof Promise) || typeof inner.cancel!=='function')throw new Error('Invalid mesh read');
      install(inner);
    } catch(error) {resultSettled=true;failInstall(error);release();throw error;}
    const result=Promise.resolve(inner.result).then((value:any)=>{
      if(cancelled || isDisposed() || isFaulted() || token!==presentationGeneration || !sameIdentity(identity,current) ||
         (state!=='ready-paused' && state!=='paused') ||
         !exact(value,['identity',attributes?'attributes':'catalog']) ||
         !exact(value.identity,['session_id','project_revision','run_epoch']) || !sameIdentity(value.identity,identity))throw new Error('Mesh result unavailable');
      return value;
    }).finally(()=>{resultSettled=true;release();});
    void result.catch(()=>{});
    return Object.freeze({result,cancel});
  }
  function beginVisualMeshRead(){return beginBinaryPresentationRead(false);}
  function beginVisualMeshAttributeRead(){return beginBinaryPresentationRead(true);}

  function beginPartialSceneRead(input:unknown,internal=false): {result:Promise<unknown>;cancel:()=>Promise<void>} {
    let visibility:boolean[];
    try {
      if(!exact(input,['visibility']))throw Error('Invalid scene request');
      const value:any=copyBounded(input,budget);
      if(!Array.isArray(value.visibility) || value.visibility.length!==6 || !value.visibility.every((v:any)=>typeof v==='boolean'))throw Error('Invalid scene visibility');
      if(state!=='ready-paused' && state!=='paused')throw Error('Scene read requires a paused session');
      if(sceneJob || (attributedJob && !internal))throw Error('Scene read already in progress');
      visibility=value.visibility;
    } catch(error) {
      const result=Promise.reject(error);void result.catch(()=>{});return Object.freeze({result,cancel:()=>Promise.resolve()});
    }
    const identity=current,version=presentationGeneration;
    let cancelled=false,settled=false,cancelSucceeded=false,mesh:ReturnType<typeof beginVisualMeshRead>|null=null,cancellation:Promise<void>|null=null;
    let result!:Promise<unknown>;
    const release=()=>{if(settled && (!cancellation || cancelSucceeded) && sceneJob===owner)sceneJob=null;};
    const valid=()=>{if(cancelled || sceneJob!==owner || (state!=='ready-paused' && state!=='paused') ||
      version!==presentationGeneration || !sameIdentity(identity,current))throw Error('Scene read unavailable');};
    const cancel=()=>{
      cancelled=true;
      if(!cancellation){cancellation=(async()=>{if(mesh)await mesh.cancel();await result.then(()=>{},()=>{});cancelSucceeded=true;release();})();void cancellation.catch(()=>{});}
      return cancellation;
    };
    const owner={cancel};sceneJob=owner;
    result=(async()=>{
      valid();const visual:any=await readVisualFacts();valid();
      if(visual.status!=='partial')throw Error('Visual facts unavailable');
      const groups:any=await readVisualGroups();valid();
      if(groups.status!=='available')throw Error('Visual groups unavailable');
      mesh=beginBinaryPresentationRead(false,internal);valid();const received:any=await mesh.result;valid();
      const catalog=received.catalog;
      if(!exact(catalog,['engine_version','meshes','geom_mesh_ids']) || catalog.engine_version!=='3.17.0' ||
         !Array.isArray(catalog.meshes) || Object.getPrototypeOf(catalog.meshes)!==Array.prototype || catalog.meshes.length>1024 ||
         Reflect.ownKeys(catalog.meshes).length!==catalog.meshes.length+1)throw Error('Invalid mesh catalog');
      const buffers=new Set<unknown>(),typed=Object.getPrototypeOf(Uint8Array.prototype),
        bufferSize=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')?.get,
        resizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
      const fixed=(v:any,kind:string)=>{
        if(!ArrayBuffer.isView(v) || Reflect.get(typed,Symbol.toStringTag,v)!==kind || !bufferSize)throw Error('Invalid mesh buffer');
        for(const key of ['buffer','byteLength','byteOffset','length','every','constructor',Symbol.iterator,Symbol.toStringTag])
          if(Object.hasOwn(v,key))throw Error('Unexpected mesh buffer property');
        const buffer=Reflect.get(typed,'buffer',v),size=Reflect.get(typed,'byteLength',v),length=Reflect.get(typed,'length',v);
        try {if(Reflect.apply(bufferSize,buffer,[])!==size || Reflect.get(typed,'byteOffset',v)!==0 || buffers.has(buffer) ||
          (resizable && Reflect.apply(resizable,buffer,[])))throw Error('Invalid buffer');new Uint8Array(buffer,0,0);}
        catch {throw Error('Invalid mesh buffer');}
        buffers.add(buffer);return {size,length};
      };
      const mapInfo=fixed(catalog.geom_mesh_ids,'Int32Array');
      if(mapInfo.length>1024)throw Error('Invalid mesh mapping');
      const mapping:number[]=[];for(let i=0;i<mapInfo.length;i++)mapping.push(catalog.geom_mesh_ids[i]);
      let bytes=mapInfo.size,vertices=0,triangles=0;
      const cleanMeshes:Array<{id:number;positions:Float32Array;indices:Uint32Array}>=[];
      for(let id=0;id<catalog.meshes.length;id++){
        const field=Object.getOwnPropertyDescriptor(catalog.meshes,String(id));
        if(!field || !field.enumerable || !Object.hasOwn(field,'value'))throw Error('Invalid mesh entry');
        const row=field.value;
        if(!exact(row,['id','positions','indices']) || row.id!==id)throw Error('Invalid mesh entry');
        const positions=fixed(row.positions,'Float32Array'),indices=fixed(row.indices,'Uint32Array');
        bytes+=positions.size+indices.size;
        if(positions.length%3 || indices.length%3 || bytes>8*1024*1024)throw Error('Invalid mesh data');
        if(positions.length/3>500000-vertices || indices.length/3>200000-triangles)throw Error('Mesh dimensions exceed limits');
        vertices+=positions.length/3;triangles+=indices.length/3;
        for(let i=0;i<positions.length;i++)if(!Number.isFinite(row.positions[i]))throw Error('Invalid mesh position');
        for(let i=0;i<indices.length;i++)if(row.indices[i]>=positions.length/3)throw Error('Invalid mesh index');
        cleanMeshes.push({id,positions:row.positions,indices:row.indices});
      }
      if(bytes>8*1024*1024)throw Error('Mesh capacity exceeded');
      const projected=projectSceneGeometry({visual:{identity:visual.identity,model:visual.model,frame:visual.frame},
        groups:{identity:groups.identity,groups:groups.groups},meshes:{identity:received.identity,mesh_count:catalog.meshes.length,
          geom_mesh_ids:mapping},visibility});
      valid();
      // Move only the locally owned, validated buffers into a fresh data-only
      // catalog; this strips custom typed-array properties without a binary copy.
      const meshCatalog=structuredClone({engine_version:'3.17.0',meshes:cleanMeshes,geom_mesh_ids:catalog.geom_mesh_ids},
        {transfer:[...buffers] as Transferable[]});
      valid();return {...projected,meshCatalog};
    })().finally(()=>{settled=true;release();});
    void result.catch(()=>{});return Object.freeze({result,cancel});
  }

  function beginAttributedSceneRead(input:unknown): {result:Promise<unknown>;cancel:()=>Promise<void>} {
    if(attributedJob || sceneJob || meshJob || (state!=='ready-paused' && state!=='paused'))throw Error('Scene read unavailable');
    if(!exact(input,['visibility']))throw Error('Invalid scene request');
    const options:any=copyBounded(input,budget);
    if(!Array.isArray(options.visibility) || options.visibility.length!==6 || !options.visibility.every((v:any)=>typeof v==='boolean'))throw Error('Invalid scene visibility');
    const identity=current,version=presentationGeneration;
    let cancelled=false,settled=false,cancelSucceeded=false,cancellation:Promise<void>|null=null;
    let child:{cancel:()=>Promise<void>}|null=null;
    let result!:Promise<unknown>;
    const release=()=>{if(settled && (!cancellation || cancelSucceeded) && attributedJob===owner)attributedJob=null;};
    const valid=()=>{if(cancelled || attributedJob!==owner || (state!=='ready-paused' && state!=='paused') ||
      version!==presentationGeneration || !sameIdentity(identity,current))throw Error('Attributed scene unavailable');};
    const cancel=()=>{
      cancelled=true;
      if(!cancellation){cancellation=(async()=>{if(child)await child.cancel();await result.then(()=>{},()=>{});cancelSucceeded=true;release();})();void cancellation.catch(()=>{});}
      return cancellation;
    };
    const owner={cancel};attributedJob=owner;
    const startChild=(start:()=>{result:Promise<unknown>;cancel:()=>Promise<void>})=>{
      let install!:(value:{result:Promise<unknown>;cancel:()=>Promise<void>})=>void,fail!:(error:unknown)=>void;
      const ready=new Promise<{result:Promise<unknown>;cancel:()=>Promise<void>}>((resolve,reject)=>{install=resolve;fail=reject;});
      void ready.catch(()=>{});
      child={cancel:()=>ready.then(value=>value.cancel())};
      try {const value=start();install(value);child=value;return value;}
      catch(error){fail(error);throw error;}
    };
    result=Promise.resolve().then(async()=>{
      valid();const sceneRead=startChild(()=>beginPartialSceneRead(options,true));valid();const scene:any=await sceneRead.result;valid();
      const attrRead=startChild(()=>beginBinaryPresentationRead(true,true));valid();const attrs:any=await attrRead.result;valid();
      const meshAttributes=joinMeshAttributes({mesh:{identity:scene.identity,catalog:scene.meshCatalog},attributes:attrs});
      valid();return {...scene,meshAttributes};
    }).finally(()=>{settled=true;release();});
    void result.catch(()=>{});return Object.freeze({result,cancel});
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    state = 'disposed';
    for(const stop of schematicStops)stop();schematicStops.clear();
    attemptOwner = null;
    for (const canvas of reservedCanvases) canvas.hidden = true;
    const waitingTarget=targetPending;
    const earlyManagerDisposal=sceneJob && !meshJob ? Promise.resolve().then(()=>manager.dispose()) : null;
    if(earlyManagerDisposal)void earlyManagerDisposal.catch(()=>{});
    const pending: Promise<void> = views.size || displayTasks.size || displayCleanupFailures.length || meshJob || sceneJob || attributedJob || waitingTarget ? (async () => {
      const failures: unknown[] = [];
      if(waitingTarget)try {await waitingTarget;} catch {}
      const viewCleanup=Promise.allSettled([...views].map(view=>view.detach()));
      if(attributedJob)try {await attributedJob.cancel();} catch(error) {failures.push(error);}
      if(sceneJob)try {await sceneJob.cancel();} catch(error) {failures.push(error);}
      if(meshJob)try {await meshJob.cancel();} catch(error) {failures.push(error);}
      const tasks = await Promise.allSettled([...displayTasks]);
      for (const result of tasks) if (result.status === 'rejected' && result.reason instanceof DisplayCleanupFailure && !displayCleanupFailures.includes(result.reason)) failures.push(result.reason);
      failures.push(...displayCleanupFailures);
      const results = await viewCleanup;
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      try { await (earlyManagerDisposal ?? manager.dispose()); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Session display cleanup failed');
    })() : manager.dispose();
    disposal = pending;
    void pending.catch(() => { if (disposal === pending) disposal = null; });
    return pending;
  }

  return Object.freeze({get identity() { return current; }, get state() { return state; }, assetNotices, recordingChannels, targets, targetHistory, captureTargetRecord, inspectTargetHistory, submit, setTarget, acquireAttempt, startBoundedAttempt, startMeasuredAttempt, beginVisualMeshRead, beginVisualMeshAttributeRead, beginPartialSceneRead, beginAttributedSceneRead, inspect, readVisual, readVisualFacts, readVisualGroups, listenSchematicFrames, attachDisplay, attachAttributedDisplay, dispose});
}

/** Constructs one admitted, paused browser session. Reset keeps the same Worker
 * and admitted project while requiring fresh controller frames and clients.
 * Callers cannot supply worlds, runners, ports, owners, leases, epochs or
 * session IDs. */
export async function createBrowserSession(input: unknown): Promise<BrowserSession> {
  if (!exact(input, ['runInput', 'mount', 'runnerOrigin', 'frameURL', 'policy'])) throw new Error('Invalid browser session input');
  rejectCallerAuthority(input, 'browser session input');
  const runInput = input.runInput;
  if (!exact(runInput, ['project_revision', 'entries', 'profile', 'controllers'])) throw new Error('Invalid admitted run input');
  rejectCallerAuthority(runInput, 'admitted run input');
  if (typeof runInput.project_revision !== 'string' || !/^[0-9a-f]{64}$/.test(runInput.project_revision)) throw new Error('Invalid admitted project revision');
  if (typeof input.runnerOrigin !== 'string' || !input.runnerOrigin || typeof input.frameURL !== 'string' || !input.frameURL) throw new Error('Invalid runner origin');
  if (!input.mount || typeof input.mount !== 'object') throw new Error('Invalid display mount');

  const policyInput = input.policy;
  if (!exact(policyInput, ['inventoryLimits', 'compileLimits', 'timeoutMs', 'maxReplyBytes', 'frameTimeoutMs', 'approvedGrants'], ['wasmUrl','approvedRecordingGrants']) ||
      !Number.isSafeInteger(policyInput.maxReplyBytes) || policyInput.maxReplyBytes < 1 ||
      !Number.isSafeInteger(policyInput.timeoutMs) || policyInput.timeoutMs < 1 ||
      !Number.isSafeInteger(policyInput.frameTimeoutMs) || policyInput.frameTimeoutMs < 1 || policyInput.frameTimeoutMs > 60000 ||
      (Object.hasOwn(policyInput, 'wasmUrl') && typeof policyInput.wasmUrl !== 'string')) throw new Error('Invalid browser session policy');
  const budget = policyInput.maxReplyBytes;
  const policy = copyBounded(policyInput, budget);
  const revision = runInput.project_revision;
  if (Object.hasOwn(policy,'approvedRecordingGrants')) {
    validateTrustedRecordingPolicy(policy.approvedRecordingGrants,revision);
    for(const row of policy.approvedRecordingGrants)if(Object.hasOwn(row,'definition') &&
      await microduckTruthDefinitionHash(row.definition)!==row.definition_sha256)throw Error('Invalid recording definition digest');
  }
  const profile = copyBounded(runInput.profile, budget);
  const controllers = copyBounded(runInput.controllers, budget);
  const mount = input.mount, runnerOrigin = input.runnerOrigin, frameURL = input.frameURL;

  let inventory;
  try { inventory = await captureProjectInventory(runInput.entries, policy.inventoryLimits); }
  catch (error) { throw new Error('Admitted project input rejected: ' + (error instanceof Error ? error.message : 'invalid input')); }
  if (inventory.project_revision !== revision) throw new Error('Admitted project revision does not match selected bytes');
  if(!Array.isArray(controllers))throw Error('Invalid controllers');
  const targetCatalog=await captureProjectTargets(inventory,controllers.map((c:any)=>({group_id:c.group_id,intent:c.intent})));
  if(targetCatalog.project_revision!==revision)throw Error('Target project mismatch');

  // The inventory owns immutable copies captured before its first await. Stage
  // those same bytes, never the caller's potentially changed or detached views.
  const captured = Object.values(inventory.files);
  const entries = await Promise.all(captured.map(async file => {
    const buffer = await Reflect.apply(readBlob, file.content, []);
    const data = new Uint8Array(buffer);
    if (data.byteLength !== file.bytes) throw new Error('Captured project file size changed');
    return {path:file.path, data};
  }));

  let manager: any;
  try {
    manager = createControlledProjectWorldManager({
      inventoryLimits: policy.inventoryLimits, compileLimits: policy.compileLimits, timeoutMs: policy.timeoutMs,
      maxReplyBytes: budget, frameTimeoutMs: policy.frameTimeoutMs, approvedGrants: policy.approvedGrants,
      ...(Object.hasOwn(policy,'approvedRecordingGrants') ? {approvedRecordingGrants:policy.approvedRecordingGrants.map(({definition,...row}:any)=>row)} : {}),
      mount, runnerOrigin, frameURL,
      ...(Object.hasOwn(policy, 'wasmUrl') ? {wasmUrl: policy.wasmUrl} : {}),
    });
    const handle = await manager.stage({entries, profile, controllers});
    const promoted = copyBounded(await manager.promote(handle), budget);
    if (!exact(promoted, ['identity'], ['asset_notices']) || !exact(promoted.identity, ['session_id', 'project_revision', 'run_epoch']) ||
        typeof promoted.identity.session_id !== 'string' || !promoted.identity.session_id ||
        !Number.isSafeInteger(promoted.identity.run_epoch) || promoted.identity.run_epoch !== 0) throw new Error('Invalid promoted session identity');
    if (promoted.identity.project_revision !== revision) throw new Error('World revision does not match admitted revision');
    const rows = Object.hasOwn(promoted, 'asset_notices') ? promoted.asset_notices : [];
    const recordCap = policy.compileLimits.audit?.max_records, byteCap = policy.compileLimits.audit?.max_bytes;
    const fileCap = policy.compileLimits.closure?.max_files;
    if (!Array.isArray(rows) || (Object.hasOwn(promoted, 'asset_notices') && rows.length === 0) ||
        (rows.length > 0 && (!Number.isSafeInteger(recordCap) || recordCap < 1 || !Number.isSafeInteger(byteCap) || byteCap < 1 ||
        !Number.isSafeInteger(fileCap) || fileCap < 1 || rows.length > recordCap || rows.length > fileCap ||
        new TextEncoder().encode(JSON.stringify(rows)).length > byteCap))) throw new Error('Invalid asset notices');
    const seen = new Set<string>();
    for (const row of rows) {
      if (!exact(row, ['path','kind','libraries','names']) || typeof row.path !== 'string' ||
          safeProjectPath(row.path) !== row.path || !/\.obj$/i.test(row.path) || !Object.hasOwn(inventory.files,row.path) ||
          seen.has(row.path) || row.kind !== 'obj_materials_ignored' || !Array.isArray(row.libraries) || !Array.isArray(row.names) ||
          row.libraries.length > 1 || row.names.length > 1 || row.libraries.length + row.names.length === 0 ||
          !row.libraries.every((s:unknown) => typeof s === 'string' && s.length <= 128 && /^[A-Za-z0-9_][A-Za-z0-9_-]*\.mtl$/.test(s)) ||
          !row.names.every((s:unknown) => typeof s === 'string' && s.length <= 128 && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(s))) throw new Error('Invalid asset notices');
      seen.add(row.path);
    }
    return makeHost(manager, promoted.identity, budget, freezeData(rows), freezeData((policy.approvedRecordingGrants??[]).map((row:any)=>({group_id:row.group_id,channel_id:row.channel_id,definition_sha256:row.definition_sha256,max_entries:row.max_entries,...(Object.hasOwn(row,'channel') ? {channel:row.channel,command_layout:commandGroupLayout(profile.blocks,profile.groups,row.group_id)} : {}),...(Object.hasOwn(row,'definition') ? {definition:row.definition} : {})}))),targetCatalog.targets,inventory,controllers.map((c:any)=>({group_id:c.group_id,intent:c.intent})));
  } catch (error) {
    if (manager) { try { await manager.dispose(); } catch { /* Preserve the construction failure. */ } }
    throw error;
  }
}

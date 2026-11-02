// Trusted supervisor: keep one controller-memory barrier active per world.
import {enterWorldOperation, reserveWorldOperation, finishWorldOperationReservation,
  releaseWorldOperationReservation} from './world-operation-fence.ts';
import {copyBounded, sameBoundedData} from '../session/project-world-wire.ts';
import {createGrantedChannelRecorder, createGrantedMeasurementRecorder} from '../experiments/measurement-recording-grant.ts';

type Assignment = {group_id: string; runner: {
  stage(value: {observation: unknown; intent: unknown; sequence: number; applyTick: number}): Promise<{stageId: string; control: unknown}>;
  commit(stageId: string): Promise<{stageId: string}>; abort(stageId: string): Promise<void>; close(): Promise<void>;
}; samples: Record<string, unknown>; intent: unknown};

export async function integrateControllerBoundary(world: any, assignments: readonly Assignment[]) {
  const releaseOperation = enterWorldOperation(world);
  try { return await runControllerBoundary(world, assignments, false, true); }
  finally { releaseOperation(); }
}

// Private path: only this module may supply supervisor-derived samples.
async function runControllerBoundary(world: any, assignments: readonly Assignment[],
  allowSamples: boolean, closeOnFailure: boolean) {
  const view=world.inspect();
  if(view.phase!=='paused') throw new Error('World must be paused');
  if (!Array.isArray(assignments)) throw new Error('Assignments must be an array');
  const copied=assignments.map(item=>{
    const keys=['group_id','runner','samples','intent'];
    if (!item || typeof item !== 'object' || Reflect.ownKeys(item).length !== keys.length ||
        !keys.every(key=>Object.prototype.hasOwnProperty.call(item,key))) {
      throw new Error('Invalid assignment shape');
    }
    const samples=item.samples;
    if (samples === null || typeof samples !== 'object' || Array.isArray(samples) ||
        (Object.getPrototypeOf(samples) !== Object.prototype && Object.getPrototypeOf(samples) !== null) ||
        (!allowSamples && Reflect.ownKeys(samples).length !== 0)) throw new Error('Samples must be an empty record');
    return {group_id:item.group_id,runner:item.runner,
      samples:structuredClone(samples),intent:structuredClone(item.intent)};
  });
  const due=[...view.due_group_ids] as string[];
  if(copied.length!==due.length || new Set(copied.map(x=>x.group_id)).size!==copied.length ||
      new Set(copied.map(x=>x.runner)).size!==copied.length ||
      due.some(id=>!copied.some(x=>x.group_id===id)) || (!allowSamples && copied.some(x=>Object.keys(x.samples).length!==0))) {
    throw new Error('Assignments must exactly match due groups with empty samples');
  }
  const groups=view.commands.groups as Array<any>;
  const prior=world.lastBoundary();
  const tick=view.plant.tick;
  if(tick!==0 && !(prior?.status==='integrated' && prior.boundary_tick+1===tick)) {
    throw new Error('Missing preceding integrated receipt');
  }
  const timestep=world.fixedTimestep();
  if(!Number.isFinite(timestep) || timestep<=0) throw new Error('Invalid fixed timestep');
  const plans=copied.map(assignment=>{
    const group=groups.find(x=>x.lease.group_id===assignment.group_id);
    if(!group) throw new Error('Unknown group');
    const previous=group.last_control_tick;
    let dt=0;
    if(tick===0) {
      if(previous!==null) throw new Error('Invalid initial control tick');
    } else {
      if(!Number.isSafeInteger(previous) || previous<0 || previous>=tick) {
        throw new Error('Missing previous control tick');
      }
      dt=(tick-previous)*timestep;
      if(!Number.isFinite(dt) || dt<=0) throw new Error('Invalid control interval');
    }
    return {assignment,group,observation:{...view.identity,tick,sim_time:view.plant.time,dt,samples:assignment.samples}};
  });
  const outcomes=await Promise.allSettled(plans.map(async ({assignment,group,observation})=>{
    const staged=await assignment.runner.stage({observation,intent:assignment.intent,
      sequence:group.accepted_sequence+1,applyTick:tick});
    if (!staged || typeof staged.stageId !== 'string' || !staged.stageId) throw new Error('Invalid stage result');
    return {assignment,group,observation,staged};
  }));
  const staged=outcomes.flatMap(x=>x.status==='fulfilled'?[x.value]:[]);
  const failed=outcomes.find(x=>x.status==='rejected');
  if(failed) {
    await Promise.allSettled(staged.map(async x=>x.assignment.runner.abort(x.staged.stageId)));
    if (closeOnFailure) await Promise.allSettled(copied.map(async x=>x.runner.close()));
    throw new Error('Controller stage failed');
  }
  const actions=staged.map(({assignment,group,observation,staged:result})=>({
    ...view.identity,group_id:assignment.group_id,owner_id:group.lease.owner_id,
    lease_generation:group.lease.generation,observed_tick:observation.tick,
    apply_tick:observation.tick,sequence:group.accepted_sequence+1,control:result.control,
  }));
  let pending;
  try { pending=world.commitBoundary(actions); }
  catch {
    await Promise.allSettled(staged.map(async x=>x.assignment.runner.abort(x.staged.stageId)));
    if (closeOnFailure) await Promise.allSettled(copied.map(async x=>x.runner.close()));
    throw new Error('World boundary commit failed');
  }
  const acknowledgments=await Promise.allSettled(staged.map(async x=>
    x.assignment.runner.commit(x.staged.stageId)));
  const invalid=acknowledgments.some((outcome,i)=>outcome.status !== 'fulfilled' ||
    !outcome.value || outcome.value.stageId !== staged[i].staged.stageId);
  if (invalid) {
    let aborted=true;
    try { world.abortCommitted(pending.token, 'controller memory acknowledgment failed'); }
    catch { aborted=false; }
    if (closeOnFailure) await Promise.allSettled(copied.map(async x=>x.runner.close()));
    throw new Error(aborted ? 'Controller acknowledgment failed' : 'Controller acknowledgment failed; world abort failed');
  }
  try { return world.integrateCommitted(pending.token); }
  catch {
    if (closeOnFailure) await Promise.allSettled(copied.map(async x=>x.runner.close()));
    throw new Error('World integration failed');
  }
}


type MeasuredRunner = Assignment['runner'] & {initialize(descriptor: unknown, parameters: unknown): Promise<void>};
type Registration = {group_id: string; runner: MeasuredRunner;
  grants: readonly {channel_id: string; definition_sha256: string}[]; parameters: unknown; intent: unknown};

// A client is consumed as soon as initialization starts, including failed initialization.
// This prevents reusing an old controller memory instance after a world reset.
const consumedMeasuredRunners = new WeakSet<object>();

/** Trusted construction requires each preconnected runner to match its registered world authority. */
export async function createMeasuredControllerSupervisor(world: any, registrations: readonly Registration[], targetDeclarations: unknown = []) {
  if (!Array.isArray(registrations)) throw new Error('Invalid registrations');
  const keys = ['group_id', 'runner', 'grants', 'parameters', 'intent'];
  const owned = registrations.map(item => {
    if (!item || typeof item !== 'object' || Reflect.ownKeys(item).length !== keys.length ||
        !keys.every(key => Object.prototype.hasOwnProperty.call(item, key))) throw new Error('Invalid registration');
    const runner = item.runner;
    if (!runner || ['initialize', 'stage', 'commit', 'abort', 'close'].some(name => typeof (runner as any)[name] !== 'function')) {
      throw new Error('Invalid runner');
    }
    return {group_id: item.group_id, runner, grants: structuredClone(item.grants),
      parameters: structuredClone(item.parameters), intent: structuredClone(item.intent)};
  });
  const initial = copyBounded(world.inspect(), Number.MAX_SAFE_INTEGER);
  const channel = copyBounded(world.describeMeasurementChannel(),8192);
  if (!channel || (channel.kind !== 'measurement' && channel.kind !== 'truth') || initial.phase !== 'paused' ||
      (!Number.isSafeInteger(initial.identity.run_epoch) || initial.identity.run_epoch < 0) || initial.plant.tick !== 0 ||
      initial.commands.groups.some((group: any) => group.accepted_sequence !== 0)) throw new Error('World is not a fresh measured world');
  const groups = initial.commands.groups as Array<any>;
  if (owned.length !== groups.length || new Set(owned.map(x => x.group_id)).size !== owned.length ||
      new Set(owned.map(x => x.runner)).size !== owned.length ||
      groups.some(group => !owned.some(x => x.group_id === group.lease.group_id))) throw new Error('Invalid group registrations');
  const bound = owned.map(item => {
    if (typeof item.group_id !== 'string' || !Array.isArray(item.grants) || item.grants.length > 1) throw new Error('Invalid grant');
    for (const grant of item.grants) {
      if (!grant || typeof grant !== 'object' || Reflect.ownKeys(grant).length !== 2 ||
          grant.channel_id !== channel.id || grant.definition_sha256 !== channel.definition_sha256) throw new Error('Invalid grant');
    }
    const group = groups.find(group => group.lease.group_id === item.group_id);
    const description = world.describeControlGroup(item.group_id);
    const inputs = description.blocks.flatMap((block: any) => block.inputs);
    if (!group || description.group_id !== item.group_id || description.control_stride !== group.lease.control_stride ||
        !Number.isSafeInteger(description.control_size) || description.control_size < 1 || inputs.length !== description.control_size) {
      throw new Error('Invalid group description');
    }
    const descriptor = structuredClone({group_id: item.group_id, control_size: description.control_size,
      inputs, control_stride: description.control_stride, observations: item.grants.length ? [channel] : []});
    return {group_id: item.group_id, runner: item.runner, parameters: item.parameters, intent: item.intent, descriptor};
  });
  const declared = copyBounded(targetDeclarations, 32768);
  if (!Array.isArray(declared) || declared.length > 32) throw new Error('Invalid target declarations');
  const targetNames = new Set<string>();
  for (const row of declared) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Reflect.ownKeys(row).length !== 4 ||
        !['group_id','field','min','max'].every(key => Object.hasOwn(row,key)) ||
        typeof row.group_id !== 'string' || typeof row.field !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.field) ||
        !Number.isFinite(row.min) || !Number.isFinite(row.max) || row.min > row.max) throw new Error('Invalid target declaration');
    const item = bound.find(candidate => candidate.group_id === row.group_id);
    const intent: any = item?.intent;
    if (!item || !intent || typeof intent !== 'object' || Array.isArray(intent) ||
        ![Object.prototype,null].includes(Object.getPrototypeOf(intent)) || !Object.hasOwn(intent,row.field) ||
        typeof intent[row.field] !== 'number' || !Number.isFinite(intent[row.field]) ||
        intent[row.field] < row.min || intent[row.field] > row.max) throw new Error('Invalid target initial value');
    const key = row.group_id + '\0' + row.field;
    if (targetNames.has(key)) throw new Error('Duplicate target declaration');
    targetNames.add(key);
  }
  const identity = structuredClone(initial.identity);
  const leases = structuredClone(groups.map(group => group.lease));
  function checkView(view: any) {
    if (view.phase !== 'paused' || view.identity.session_id !== identity.session_id ||
        view.identity.project_revision !== identity.project_revision || view.identity.run_epoch !== identity.run_epoch ||
        JSON.stringify(view.commands.groups.map((group: any) => group.lease)) !== JSON.stringify(leases)) {
      throw new Error('World authority changed');
    }
  }
  if (bound.some(item => consumedMeasuredRunners.has(item.runner))) throw new Error('Runner already used');
  const reservation = reserveWorldOperation(world);
  for (const item of bound) consumedMeasuredRunners.add(item.runner);
  let closed = false, closing = false;
  let closePromise: Promise<void> | null = null;
  const closeClients = () => closePromise ??= Promise.allSettled(bound.map(async item => item.runner.close())).then(results => {
    if (results.some(result => result.status === 'rejected')) throw new Error('Controller close failed');
  });
  try {
    const results = await Promise.allSettled(bound.map(async item =>
      item.runner.initialize(structuredClone(item.descriptor), structuredClone(item.parameters))));
    if (results.some(result => result.status === 'rejected')) throw new Error('Controller initialization failed');
    const afterInitialization = copyBounded(world.inspect(), Number.MAX_SAFE_INTEGER);
    checkView(afterInitialization);
    if (!sameBoundedData(afterInitialization, initial)) throw new Error('World changed during controller initialization');
    finishWorldOperationReservation(world, reservation);
  } catch (error) {
    try { await closeClients(); }
    catch (closeError) {
      // Keep the lifetime reservation, but permit disposal of the underlying world.
      finishWorldOperationReservation(world, reservation);
      throw closeError;
    }
    releaseWorldOperationReservation(world, reservation);
    throw error;
  }
  let active: Promise<any> | null = null;
  const stepRecorders=new WeakSet<object>();
  function createStepRecorder(input:unknown,count:number){
    if(closed||closing||active||!Number.isSafeInteger(count)||count<1||count>64)throw Error('Recording unavailable');
    const config=copyBounded(input,8192),keys=['authority','grant'];
    if(!config||typeof config!=='object'||Array.isArray(config)||Reflect.ownKeys(config).length!==keys.length||!keys.every(k=>Object.hasOwn(config,k)))throw Error('Invalid recording request');
    const authority=config.authority,lease=leases.find((x:any)=>x.group_id===authority?.group_id);
    if(!lease||authority.session_id!==identity.session_id||authority.project_revision!==identity.project_revision||authority.run_epoch!==identity.run_epoch||
       authority.lease_generation!==lease.generation||authority.channel_id!==channel.id||authority.definition_sha256!==channel.definition_sha256||
       !config.grant||config.grant.max_entries<count)throw Error('Invalid recording authority');
    let recorder:ReturnType<typeof createGrantedMeasurementRecorder> & {readonly channel?:unknown};
    if(config.grant.purpose==='channel-recording') {
      const granted=createGrantedChannelRecorder(authority,config.grant,channel);
      recorder=Object.freeze({...granted.log,channel:granted.channel});
    } else recorder=createGrantedMeasurementRecorder(authority,config.grant);
    stepRecorders.add(recorder);return recorder;
  }
  function setTarget(input: unknown) {
    if (closed || closing || active) throw new Error('Supervisor is unavailable');
    const request = copyBounded(input, 4096);
    const keys = ['session_id','project_revision','run_epoch','group_id','field','lease_generation','value'];
    if (!request || typeof request !== 'object' || Array.isArray(request) || Reflect.ownKeys(request).length !== keys.length ||
        !keys.every(key => Object.hasOwn(request,key)) || typeof request.value !== 'number' || !Number.isFinite(request.value)) {
      throw new Error('Invalid target request');
    }
    const release = enterWorldOperation(world, reservation);
    try {
      const view = copyBounded(world.inspect(), 1048576); checkView(view);
      if (request.session_id !== identity.session_id || request.project_revision !== identity.project_revision || request.run_epoch !== identity.run_epoch) throw new Error('Stale target identity');
      const group = groups.find(row => row.lease.group_id === request.group_id);
      const definition = declared.find((row: any) => row.group_id === request.group_id && row.field === request.field);
      const item = bound.find(row => row.group_id === request.group_id);
      if (!group || !definition || !item || request.lease_generation !== group.lease.generation ||
          request.value < definition.min || request.value > definition.max) throw new Error('Target is not permitted');
      const next: any = structuredClone(item.intent); next[request.field] = request.value; item.intent = next;
      return Object.freeze({...identity,group_id:request.group_id,field:request.field,value:request.value,
        lease_generation:group.lease.generation,tick:view.plant.tick});
    } finally { release(); }
  }
  async function integrateBoundary(recorder:ReturnType<typeof createGrantedMeasurementRecorder>|undefined=undefined) {
    if (arguments.length>1 || (arguments.length===1 && (!recorder || !stepRecorders.has(recorder)))) throw new Error('Invalid boundary recorder');
    if (closed || closing || active) throw new Error('Supervisor is unavailable');
    const release = enterWorldOperation(world, reservation);
    const operation = (async () => {
      let failed = false, clientsClosed = false, recordingTick:number|null=null;
      try {
        const view = world.inspect();
        checkView(view);
        const prepared = world.prepareBoundary();
        if (!prepared || prepared.identity?.session_id !== identity.session_id ||
            prepared.identity?.project_revision !== identity.project_revision || prepared.identity?.run_epoch !== identity.run_epoch ||
            prepared.observed_tick !== view.plant.tick || JSON.stringify(prepared.channel) !== JSON.stringify(channel)) {
          throw new Error('Invalid prepared measurement');
        }
        if(recorder){if(!recorder.capture({authority:recorder.snapshot().authority,observed_tick:prepared.observed_tick,sample:prepared.sample}))throw Error('Recording capacity exceeded');recordingTick=prepared.observed_tick;}
        const assignments = view.due_group_ids.map((group_id: string) => {
          const item = bound.find(candidate => candidate.group_id === group_id);
          if (!item) throw new Error('Unknown due group');
          const samples: Record<string, unknown> = {};
          for (const observation of item.descriptor.observations) samples[observation.id] = structuredClone(prepared.sample);
          return {group_id, runner: item.runner, intent: structuredClone(item.intent), samples};
        });
        const result=await runControllerBoundary(world, assignments, true, false);
        if(recorder){recorder.settle(prepared.observed_tick,'completed');recordingTick=null;}
        return result;
      } catch (error) {
        if(recorder&&recordingTick!==null)try{recorder.settle(recordingTick,'unknown');}catch{}
        failed = true; closed = true;
        await closeClients();
        clientsClosed = true;
        throw error;
      } finally {
        release();
        if (failed && clientsClosed) releaseWorldOperationReservation(world, reservation);
      }
    })();
    active = operation;
    try { return await operation; } finally { active = null; }
  }
  let disposal: Promise<void> | null = null;
  function dispose() {
    if (disposal) return disposal;
    closing = true;
    disposal = (async () => {
      if (active) { try { await active; } catch {} }
      await closeClients();
      if (!closed) { closed = true; releaseWorldOperationReservation(world, reservation); }
    })();
    return disposal;
  }
  return {integrateBoundary, createStepRecorder, setTarget, dispose};
}

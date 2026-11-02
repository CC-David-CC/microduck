import {captureProjectInventory} from '../projects/project-inventory.ts';
import {createMujocoWorldFromProject} from '../simulation/mujoco-world.ts';
import {prepareWorldControllerBindings, bindWorldControllers} from './world-controller-bind.ts';
import {copyBounded, DataBudgetExceeded} from './project-world-wire.ts';
import {channelStepBudget} from '../experiments/channel-step-budget.ts';
import {createCommandBatchRecorder} from '../experiments/command-batch-record.ts';
import {commandBatchBudget,stepEnvelopeBudget} from '../experiments/command-batch-budget.ts';

type HeldWorld = Awaited<ReturnType<typeof createMujocoWorldFromProject>>['world'];
type Supervisor = Awaited<ReturnType<typeof bindWorldControllers>>;
let world: HeldWorld | null = null, supervisor: Supervisor | null = null;
let state: 'empty' | 'starting' | 'awaiting-runners' | 'binding' | 'ready' | 'stepping' | 'resetting' | 'failing' | 'cancelling' | 'disposed' = 'empty';
let generation = 0, replyLimit = 0, requestId = '', runnerTimeoutMs = 0, commandSequence = 0;
let bindingHandle: object | null = null, readyAudit: unknown = null;
let task: Promise<void> | null = null, portCleanupFailed = false, disposeRequested = false, stageFailedWhileCancelling = false;
let heldInventory: Awaited<ReturnType<typeof captureProjectInventory>> | null = null;
let targetPolicy: readonly any[] = [];
let targetSequence = 0;
let commandContinuation:{token:string;authority:any;last:any}|null=null;
let heldControllers: unknown = null, bindingKind: 'stage' | 'reset' | null = null;
const worker = self as unknown as {postMessage(value: unknown): void; close(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void};
const portGetter = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')?.get;
const closePort = MessagePort.prototype.close;
// Ports already handed to the controller binder remain its responsibility.
const boundPorts = new WeakSet<object>();
function send(value: unknown) { worker.postMessage(copyBounded(value, replyLimit)); }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const keys=Reflect.ownKeys(value);
  return keys.every(key => typeof key === 'string' && [...required,...optional].includes(key) &&
    !!Object.getOwnPropertyDescriptor(value,key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!, 'value')) &&
    required.every(key => Object.hasOwn(value,key));
}
function nativePort(value: unknown): value is MessagePort {
  if (!value || typeof value !== 'object' || !portGetter) return false;
  try { Reflect.apply(portGetter,value,[]); return true; } catch { return false; }
}
function visibleRowPorts(message: any): Set<MessagePort> {
  const ports = new Set<MessagePort>();
  const rows = message && typeof message === 'object' ? Object.getOwnPropertyDescriptor(message,'ports')?.value : null;
  if (Array.isArray(rows)) for (let i=0; i<Math.min(rows.length,64); i++) {
    const slot=Object.getOwnPropertyDescriptor(rows,String(i)); const row=slot && Object.hasOwn(slot,'value') ? slot.value : null;
    if (!row || typeof row !== 'object') continue;
    for (const name of ['dataPort','lifecyclePort']) {
      const item=Object.getOwnPropertyDescriptor(row,name); const port=item && Object.hasOwn(item,'value') ? item.value : null;
      if (nativePort(port)) ports.add(port);
    }
  }
  return ports;
}
function discardPorts(event: MessageEvent, message: any) {
  const ports = visibleRowPorts(message);
  for (const port of event.ports || []) if (nativePort(port)) ports.add(port);
  for (const port of ports) if (!boundPorts.has(port)) {
    try { Reflect.apply(closePort,port,[]); } catch { portCleanupFailed = true; }
  }
}
function failure(reason: unknown) {
  if (state === 'failing' || state === 'cancelling' || state === 'disposed') return;
  state = 'failing'; bindingHandle = null;
  void (async () => {
    // Task owns any in-flight world construction or controller initialization.
    if (task) { try { await task; } catch {} }
    let cleanupFailed=false;
    if (supervisor) { try { await supervisor.dispose(); } catch { cleanupFailed=true; } supervisor=null; }
    if (world) { try { world.dispose(); } catch { cleanupFailed=true; } world=null; }
    state='disposed';
    const error=cleanupFailed || portCleanupFailed ? 'Worker cleanup failed' : String(reason).slice(0,2000);
    try { send({kind:'error',request_id:requestId,generation,error}); } catch { worker.close(); }
  })();
}
worker.addEventListener('message', event => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    discardPorts(event,message);
    if (portCleanupFailed) { if (state === 'empty') worker.close(); else failure('Worker cleanup failed'); }
    return;
  }
  if (message.kind !== 'bind-runners') {
    discardPorts(event,message);
    if (portCleanupFailed) { if (state === 'empty') worker.close(); else failure('Worker cleanup failed'); return; }
  }
  if (message.kind === 'stage' && state === 'empty') {
    state='starting'; generation=message.generation; requestId=message.request_id; replyLimit=message.maxReplyBytes;
    const controlled=Object.hasOwn(message,'controllers') || Object.hasOwn(message,'runnerTimeoutMs');
    task=(async () => {
      try {
        let controllers: unknown;
        if (controlled) {
          if (!exact(message,['kind','request_id','generation','entries','profile','inventoryLimits','compileLimits','maxReplyBytes','controllers','runnerTimeoutMs'],['wasmUrl']) ||
              typeof requestId !== 'string' || !requestId || !Number.isSafeInteger(generation) || generation < 1 ||
              !Number.isSafeInteger(replyLimit) || replyLimit < 1 || typeof message.runnerTimeoutMs !== 'number' ||
              !Number.isFinite(message.runnerTimeoutMs) || message.runnerTimeoutMs <= 0 || message.runnerTimeoutMs > 60000) throw new Error('Invalid controlled stage');
          runnerTimeoutMs=message.runnerTimeoutMs;
          controllers=copyBounded(message.controllers,replyLimit);
          heldControllers=controllers;
        }
        const inventory=await captureProjectInventory(message.entries,message.inventoryLimits);
        heldInventory=inventory;
        if (state !== 'starting') return;
        const result=await createMujocoWorldFromProject(inventory,message.profile,message.compileLimits,
          message.wasmUrl === undefined ? {} : {wasmUrl:message.wasmUrl});
        world=result.world; readyAudit=result.audit;
        if (state !== 'starting') return;
        const inspection=world.inspect();
        if (!controlled) {
          state='ready';
          send({kind:'ready',request_id:requestId,generation,identity:inspection.identity,phase:'paused',audit:result.audit,inspection});
          return;
        }
        const prepared=await prepareWorldControllerBindings(inventory,world,controllers);
        if (state !== 'starting') return;
        bindingHandle=prepared.handle; targetPolicy=prepared.targets; bindingKind='stage'; state='awaiting-runners';
        send({kind:'need-runners',request_id:requestId,generation,identity:inspection.identity,phase:'paused',audit:result.audit,inspection,group_ids:prepared.group_ids});
      } catch (error) { if (disposeRequested) stageFailedWhileCancelling = true; else failure(error); }
    })();
  } else if (message.kind === 'cancel-stage') {
    if ((event.ports?.length ?? 0) !== 0 || disposeRequested || (state !== 'starting' && state !== 'awaiting-runners') ||
        !exact(message,['kind','request_id','generation','stage_request_id']) || typeof message.request_id !== 'string' ||
        !message.request_id || message.request_id.length > 256 || message.generation !== generation || message.stage_request_id !== requestId) return;
    disposeRequested = true; state = 'cancelling'; bindingHandle = null; bindingKind = null;
    const cancelId = message.request_id, inFlight = task;
    void (async () => {
      if (inFlight) { try { await inFlight; } catch {} }
      let cleanupFailed = stageFailedWhileCancelling;
      if (supervisor) { try { await supervisor.dispose(); } catch { cleanupFailed = true; } supervisor = null; }
      if (world) { try { world.dispose(); } catch { cleanupFailed = true; } world = null; }
      state = 'disposed';
      try {
        if (cleanupFailed || portCleanupFailed) send({kind:'stage-dispose-error',request_id:cancelId,generation,stage_request_id:requestId,error:'Worker cleanup failed'});
        else send({kind:'stage-disposed',request_id:cancelId,generation,stage_request_id:requestId});
      } catch { worker.close(); }
    })();
  } else if (message.kind === 'bind-runners') {
    if (state !== 'awaiting-runners' || !bindingHandle || !exact(message,['kind','request_id','generation','ports']) ||
        message.request_id !== requestId || message.generation !== generation) {
      discardPorts(event,message);
      // An already-authorized boundary may be awaiting a controller. A stale
      // duplicate bind cannot cancel or add work to that boundary; only a
      // failure to discard its newly transferred ports faults the Worker.
      if (state === 'cancelling' || (state === 'stepping' && !portCleanupFailed)) return;
      failure(portCleanupFailed ? 'Worker cleanup failed' : 'Invalid runner binding'); return;
    }
    const rowPorts=visibleRowPorts(message);
    if ((event.ports || []).some(port => !rowPorts.has(port))) {
      discardPorts(event,message); failure('Invalid runner transfer'); return;
    }
    for (const port of rowPorts) boundPorts.add(port);
    const handle=bindingHandle, kind=bindingKind; bindingHandle=null; bindingKind=null; state='binding';
    task=(async () => {
      try {
        const bound=await bindWorldControllers(handle,message.ports,runnerTimeoutMs);
        supervisor=bound;
        if (state !== 'binding') return;
        if (!world) throw new Error('World unavailable');
        const inspection=world.inspect(); state='ready';
        if (disposeRequested) return;
        // Admission audit and baseline are returned in need-runners; readiness
        // reuses them only after all controller initialization ACKs.
        send({kind:kind === 'reset' ? 'reset-ready' : 'ready',request_id:requestId,generation,
          identity:inspection.identity,phase:'paused',audit:readyAudit,inspection});
      } catch (error) { failure(error); }
    })();
  } else if (message.kind === 'reset') {
    if ((event.ports?.length ?? 0) !== 0 || disposeRequested || state !== 'ready' || !world || !supervisor ||
        !heldInventory || heldControllers === null ||
        !exact(message,['kind','request_id','generation','identity']) ||
        typeof message.request_id !== 'string' || !message.request_id || message.request_id.length > 256 ||
        message.generation !== generation || !exact(message.identity,['session_id','project_revision','run_epoch'])) return;
    const identity = world.inspect().identity;
    if (message.identity.session_id !== identity.session_id || message.identity.project_revision !== identity.project_revision ||
        message.identity.run_epoch !== identity.run_epoch) return;
    const resetId = message.request_id, previousSupervisor = supervisor;
    supervisor = null; commandContinuation=null; state = 'resetting'; requestId = resetId;
    task = (async () => {
      try {
        await previousSupervisor.dispose();
        if (state !== 'resetting') return;
        const inspection = world!.reset();
        if (state !== 'resetting') return;
        commandSequence = 0; targetSequence = 0;
        const prepared = await prepareWorldControllerBindings(heldInventory!, world!, heldControllers);
        if (state !== 'resetting') return;
        bindingHandle = prepared.handle; targetPolicy=prepared.targets; bindingKind = 'reset'; state = 'awaiting-runners';
        send({kind:'need-runners',request_id:resetId,generation,identity:inspection.identity,phase:'paused',
          audit:readyAudit,inspection,group_ids:prepared.group_ids});
      } catch (error) {
        try { send({kind:'reset-error',request_id:resetId,generation,error:String(error).slice(0,2000)}); } catch {}
        failure(error);
      }
    })();
  } else if (message.kind === 'dispose') {
    if ((event.ports?.length ?? 0) !== 0 || disposeRequested || !world ||
        (state !== 'ready' && state !== 'stepping' && state !== 'binding' && state !== 'awaiting-runners') ||
        !exact(message,['kind','request_id','generation','identity']) ||
        typeof message.request_id !== 'string' || !message.request_id || message.request_id.length > 256 ||
        message.generation !== generation || !exact(message.identity,['session_id','project_revision','run_epoch'])) return;
    const identity = world.inspect().identity;
    if (message.identity.session_id !== identity.session_id || message.identity.project_revision !== identity.project_revision ||
        message.identity.run_epoch !== identity.run_epoch) return;
    disposeRequested = true;
    const disposeId = message.request_id, boundary = (state === 'stepping' || state === 'binding') ? task : null;
    if (state === 'awaiting-runners') { bindingHandle = null; bindingKind = null; state = 'ready'; }
    void (async () => {
      if (boundary) { try { await boundary; } catch {} }
      if (state !== 'ready') return; // The existing failure path owns cleanup.
      state = 'failing'; let cleanupFailed = false;
      if (supervisor) { try { await supervisor.dispose(); } catch { cleanupFailed = true; } supervisor = null; }
      if (world) { try { world.dispose(); } catch { cleanupFailed = true; } world = null; }
      state = 'disposed';
      try {
        if (cleanupFailed || portCleanupFailed) send({kind:'dispose-error',request_id:disposeId,generation,identity,error:'Worker cleanup failed'});
        else send({kind:'disposed',request_id:disposeId,generation,identity});
      } catch { worker.close(); }
    })();
  } else if (message.kind === 'set-target') {
    if ((event.ports?.length ?? 0) !== 0 || disposeRequested || state !== 'ready' || !world || !supervisor ||
        !exact(message,['kind','request_id','generation','identity','group_id','field','value','target_sequence']) ||
        typeof message.request_id !== 'string' || !message.request_id || message.request_id.length > 256 ||
        message.generation !== generation || !exact(message.identity,['session_id','project_revision','run_epoch']) ||
        typeof message.group_id !== 'string' || typeof message.field !== 'string' || typeof message.value !== 'number' || !Number.isFinite(message.value) ||
        !Number.isSafeInteger(message.target_sequence) || message.target_sequence !== targetSequence + 1) return;
    const view=world.inspect(), identity=view.identity;
    if (message.identity.session_id !== identity.session_id || message.identity.project_revision !== identity.project_revision || message.identity.run_epoch !== identity.run_epoch) return;
    targetSequence = message.target_sequence;
    const target=targetPolicy.find(row=>row.group_id===message.group_id && row.field===message.field);
    if (!target || message.value < target.min || message.value > target.max) {
      try { send({kind:'target-result',request_id:message.request_id,generation,identity,status:'rejected',target_sequence:message.target_sequence,group_id:message.group_id,field:message.field,value:message.value,reason:'not_permitted'}); }
      catch (error) { failure(error); } return;
    }
    try {
      const group=view.commands.groups.find((row:any)=>row.lease.group_id===message.group_id);
      if (!group) throw Error('Missing target group');
      const receipt=supervisor.setTarget({...identity,group_id:message.group_id,field:message.field,value:message.value,lease_generation:group.lease.generation});
      send({kind:'target-result',request_id:message.request_id,generation,identity,status:'accepted',target_sequence:message.target_sequence,group_id:receipt.group_id,field:receipt.field,value:receipt.value,lease_generation:receipt.lease_generation,tick:receipt.tick});
    } catch (error) { failure(error); }
  } else if (message.kind === 'step' || message.kind === 'step-recorded') {
    // A step carries no capabilities; reject after discarding any transferred ports.
    if ((event.ports?.length ?? 0) !== 0) return;
    if (disposeRequested || state !== 'ready' || !world || !supervisor ||
        !exact(message,['kind','request_id','generation','identity','command_sequence','steps'],['capture_forward_pose','recording']) ||
        (Object.hasOwn(message,'capture_forward_pose') && message.capture_forward_pose !== true) ||
        typeof message.request_id !== 'string' || !message.request_id || message.request_id.length > 256 ||
        message.generation !== generation || !exact(message.identity,['session_id','project_revision','run_epoch']) ||
        !Number.isSafeInteger(message.command_sequence) || message.command_sequence !== commandSequence + 1 ||
        !Number.isSafeInteger(message.steps) || message.steps < 1 || message.steps > 64) return;
    const initialInspection=world.inspect(),identity=initialInspection.identity,combined=message.kind==='step-recorded';
    if (message.identity.session_id !== identity.session_id || message.identity.project_revision !== identity.project_revision ||
        message.identity.run_epoch !== identity.run_epoch) return;
    const stepRequest = message.request_id, sequence = message.command_sequence, count = message.steps;
    const owner = supervisor, heldWorld = world;
    const startTick=initialInspection.plant.tick;
    let recording:any=null,recorder:ReturnType<typeof owner.createStepRecorder>|null=null;
    let commandRecorder:ReturnType<typeof createCommandBatchRecorder>|null=null;
    if(Object.hasOwn(message,'recording')){
      try{
        recording=copyBounded(message.recording,8192);
        if(!exact(recording,['authority','grant','attempt_token'])||typeof recording.attempt_token!=='string'||!recording.attempt_token||recording.attempt_token.length>256)throw Error('Invalid recording request');
        recorder=owner.createStepRecorder({authority:recording.authority,grant:recording.grant},count);
        const measurementBound=recorder.channel!==undefined ? channelStepBudget({request_id:stepRequest,generation,command_sequence:sequence,identity,start_tick:startTick,steps:count,attempt_token:recording.attempt_token,authority:recording.authority},recorder.channel) : 0;
        if(combined){
          if(recorder.channel===undefined||Object.hasOwn(message,'capture_forward_pose'))throw Error('Combined recording requires a channel grant');
          const a=recording.authority,commandAuthority={...identity,group_id:a.group_id,lease_generation:a.lease_generation},layout=heldWorld.describeControlGroup(a.group_id);
          const c=commandContinuation,prior=c&&c.token===recording.attempt_token&&c.authority.session_id===identity.session_id&&c.authority.project_revision===identity.project_revision&&c.authority.run_epoch===identity.run_epoch&&c.authority.group_id===a.group_id&&c.authority.lease_generation===a.lease_generation&&c.last?.boundary_tick===startTick-1?c.last:undefined;
          commandRecorder=createCommandBatchRecorder(commandAuthority,layout,startTick,count,prior);
          const commandBound=commandBatchBudget(commandAuthority,layout,startTick,count);
          const envelope={kind:'stepped',request_id:stepRequest,generation,identity,command_sequence:sequence,steps_completed:count,inspection:initialInspection};
          // Any group may be due at the resulting tick, even if the starting
          // due list is empty. Reserve all group IDs in addition to the envelope.
          const dueAllowance=initialInspection.commands.groups.reduce((n:number,row:any)=>n+new TextEncoder().encode(JSON.stringify(row.lease.group_id)).length+1,0);
          if(stepEnvelopeBudget(envelope)+dueAllowance+measurementBound+commandBound+100>replyLimit)throw Error('Combined response exceeds budget');
        }
      }catch{try{send({kind:'step-error',request_id:stepRequest,generation,identity,command_sequence:sequence,steps_completed:0,error:'Recording not authorized'});}catch{}return;}
    }
    if(combined&&!commandRecorder){try{send({kind:'step-error',request_id:stepRequest,generation,identity,command_sequence:sequence,steps_completed:0,error:'Recording not authorized'});}catch{}return;}
    if(!combined)commandContinuation=null;
    commandSequence = sequence; state = 'stepping';
    task = (async () => {
      let completed = 0;
      try {
        while (completed < count) {
          if (state !== 'stepping') return;
          const receipt=recorder ? await owner.integrateBoundary(recorder) : await owner.integrateBoundary();
          completed++;
          if(commandRecorder){const group=heldWorld.inspect().commands.groups.find((row:any)=>row.lease.group_id===recording.authority.group_id);commandRecorder.capture(receipt,group);}
          if (state !== 'stepping') return;
        }
        const inspection = heldWorld.inspect();
        const acknowledgment:any = {kind:'stepped',request_id:stepRequest,generation,identity,command_sequence:sequence,
          steps_completed:completed,inspection};
        if(recorder)acknowledgment.measurement_batch={request_id:stepRequest,generation,command_sequence:sequence,identity,start_tick:startTick,steps:count,attempt_token:recording.attempt_token,authority:recording.authority,...(recorder.channel!==undefined?{channel:recorder.channel}:{}),rows:recorder.snapshot().entries};
        if(commandRecorder)acknowledgment.command_batch=copyBounded(commandRecorder.snapshot(),65536);
        let pose:ReturnType<HeldWorld['forwardVisualFrame']> | null = null;
        if (message.capture_forward_pose === true) {
          try {
            const value = heldWorld.forwardVisualFrame(64);
            if (value.identity.session_id === identity.session_id && value.identity.project_revision === identity.project_revision &&
                value.identity.run_epoch === identity.run_epoch && value.frame.tick === inspection.plant.tick &&
                Object.is(value.frame.time, inspection.plant.time)) pose = value;
          } catch { /* Optional display data cannot fault an accepted step. */ }
        }
        let output: unknown;
        if (pose) {
          try { output = copyBounded({...acknowledgment,forward_pose:pose}, replyLimit); }
          catch { output = copyBounded(acknowledgment, replyLimit); }
        } else output = copyBounded(acknowledgment, replyLimit);
        worker.postMessage(output);
        if(commandRecorder)commandContinuation={token:recording.attempt_token,authority:{...identity,group_id:recording.authority.group_id,lease_generation:recording.authority.lease_generation},last:commandRecorder.lastRecord()};
        state = 'ready';
      } catch (error) {
        if (state !== 'stepping') return;
        const errorReply:any={kind:'step-error',request_id:stepRequest,generation,identity,command_sequence:sequence,steps_completed:completed,error:'Controller step failed'};
        commandContinuation=null;
        if(commandRecorder)try{const n=commandRecorder.snapshot().rows.length;if(n<count)commandRecorder.markUnknown(startTick+n);errorReply.command_batch=copyBounded(commandRecorder.snapshot(),65536);}catch{}
        if(recorder)try{errorReply.measurement_batch={request_id:stepRequest,generation,command_sequence:sequence,identity,start_tick:startTick,steps:count,attempt_token:recording.attempt_token,authority:recording.authority,...(recorder.channel!==undefined?{channel:recorder.channel}:{}),rows:recorder.snapshot().entries};}catch{}
        try {send(errorReply);} catch {try{delete errorReply.measurement_batch;delete errorReply.command_batch;send(errorReply);}catch{}}
        failure(error);
      }
    })();
  } else if (message.kind === 'visual-read') {
    if ((event.ports?.length ?? 0) !== 0 || disposeRequested || state !== 'ready' || !world || !supervisor ||
        !exact(message,['kind','request_id','generation','identity']) || typeof message.request_id !== 'string' ||
        !message.request_id || message.request_id.length > 256 || message.generation !== generation ||
        !exact(message.identity,['session_id','project_revision','run_epoch'])) return;
    const inspection=world.inspect(), identity=inspection.identity;
    if(message.identity.session_id!==identity.session_id || message.identity.project_revision!==identity.project_revision || message.identity.run_epoch!==identity.run_epoch) return;
    try {
      const visual=world.visualSnapshot();
      if(visual.identity.session_id!==identity.session_id || visual.identity.project_revision!==identity.project_revision || visual.identity.run_epoch!==identity.run_epoch) throw Error('Visual identity mismatch');
      try {send({kind:'visual-result',request_id:message.request_id,generation,identity,inspection,model:visual.model,frame:visual.frame});}
      catch(error) {if(!(error instanceof DataBudgetExceeded))throw error;send({kind:'visual-unavailable',request_id:message.request_id,generation,identity,inspection,reason:'capacity'});}
    } catch {try {send({kind:'visual-error',request_id:message.request_id,generation,identity,inspection});} catch {worker.close();}}
  } else if (message.kind === 'inspect' && !disposeRequested && state === 'ready' && world && message.generation === generation) {
    try { send({kind:'inspection',request_id:message.request_id,generation,inspection:world.inspect()}); }
    catch (error) { try { send({kind:'error',request_id:message.request_id,generation,error:String(error).slice(0,2000)}); } catch { worker.close(); } }
  }
});

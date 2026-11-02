type Authority = {
  session_id: string; project_revision: string; run_epoch: number; group_id: string;
  owner_id: string; lease_generation: number; observed_tick: number; apply_tick: number; sequence: number;
};
type Reply = Record<string, unknown>;
type StageArgs = {observation: unknown; intent: unknown; sequence: number; applyTick: number};

const apply=Reflect.apply;
const ownKeys=Reflect.ownKeys;
const ownDescriptor=Object.getOwnPropertyDescriptor;
const prototypeOf=Object.getPrototypeOf;
const isArray=Array.isArray;
const finite=Number.isFinite;
const floor=Math.floor;
const NativeArray=Array;
const NativeNumber=Number;
const NativeString=String;
const NativeTextEncoder=TextEncoder;
const encoder=new NativeTextEncoder();
const encode=NativeTextEncoder.prototype.encode;
const stringify=JSON.stringify;
const plainPrototype=Object.prototype;
const arrayPrototype=Array.prototype;
const maxMemoryBytes=16384;
const maxDiagnosticsBytes=1024;
const maxObservationBytes=2048;
const maxDepth=12;
const maxNodes=4096;
const maxMessagesPerWindow=128;
const rateWindowMs=1000;

function fault(code: string): Error { return Object.assign(new Error(code),{code}); }
function hasOwn(value: object,key: PropertyKey): boolean { return ownDescriptor(value,key)!==undefined; }
function data(value: unknown,key: string): unknown {
  if(value===null || typeof value!=='object') return undefined;
  const descriptor=ownDescriptor(value,key);
  return descriptor && hasOwn(descriptor,'value') ? descriptor.value : undefined;
}
function exactRecord(value: unknown,keys: readonly string[]): value is Record<string,unknown> {
  if(value===null || typeof value!=='object') return false;
  const proto=prototypeOf(value);
  if(proto!==plainPrototype && proto!==null) return false;
  const names=ownKeys(value);
  if(names.length!==keys.length) return false;
  for(let i=0;i<names.length;i++) {
    if(typeof names[i]!=='string') return false;
    let found=false;
    for(let j=0;j<keys.length;j++) if(names[i]===keys[j]) {found=true;break;}
    const descriptor=ownDescriptor(value,names[i] as string);
    if(!found || !descriptor || !hasOwn(descriptor,'value') || !descriptor.enumerable) return false;
  }
  return true;
}
function safeInt(value: unknown,min=0): value is number {
  return typeof value==='number' && finite(value) && floor(value)===value && value>=min && value<=0x1fffffffffffff;
}
function revision(value: unknown): value is string {
  if(typeof value!=='string' || value.length!==64) return false;
  for(let i=0;i<64;i++) { const c=value.charCodeAt(i); if(!((c>=48&&c<=57)||(c>=97&&c<=102))) return false; }
  return true;
}
function utf8Length(value: string): number { return (apply(encode,encoder,[value]) as Uint8Array).byteLength; }
function quotedLength(value: string): number { return utf8Length(apply(stringify,JSON,[value]) as string); }
function arrayIndex(key: string,length: number): boolean {
  const index=NativeNumber(key);
  return safeInt(index) && index<length && NativeString(index)===key;
}
function boundedClone(value: unknown,limit: number): {ok: true; value: unknown; bytes: number; nodes: number}|{ok:false} {
  let bytes=0,nodes=0;
  const ancestors: object[]=[];
  function visit(input: unknown,depth: number): {ok: boolean; value?: unknown} {
    nodes++;
    if(nodes>maxNodes || depth>maxDepth) return {ok:false};
    if(input===null) {bytes+=4;return {ok:bytes<=limit,value:null};}
    if(typeof input==='boolean') {bytes+=input?4:5;return {ok:bytes<=limit,value:input};}
    if(typeof input==='number') {
      if(!finite(input)) return {ok:false};
      bytes+=(apply(stringify,JSON,[input]) as string).length;
      return {ok:bytes<=limit,value:input};
    }
    if(typeof input==='string') {
      if(input.length>limit) return {ok:false};
      bytes+=quotedLength(input);
      return {ok:bytes<=limit,value:input};
    }
    if(typeof input!=='object') return {ok:false};
    for(let i=0;i<ancestors.length;i++) if(ancestors[i]===input) return {ok:false};
    ancestors[ancestors.length]=input;
    let output: unknown;
    if(isArray(input)) {
      if(prototypeOf(input)!==arrayPrototype) {ancestors.length--;return {ok:false};}
      const lengthDesc=ownDescriptor(input,'length');
      if(!lengthDesc || !hasOwn(lengthDesc,'value') || !safeInt(lengthDesc.value) || lengthDesc.value>maxNodes) {ancestors.length--;return {ok:false};}
      const length=lengthDesc.value as number;const names=ownKeys(input);
      if(names.length!==length+1) {ancestors.length--;return {ok:false};}
      bytes+=2+(length>1?length-1:0);
      const result=new NativeArray(length);
      for(let i=0;i<length;i++) {
        const descriptor=ownDescriptor(input,NativeString(i));
        if(!descriptor || !hasOwn(descriptor,'value') || !descriptor.enumerable) {ancestors.length--;return {ok:false};}
        const child=visit(descriptor.value,depth+1);
        if(!child.ok) {ancestors.length--;return {ok:false};}
        result[i]=child.value;
      }
      for(let i=0;i<names.length;i++) {const key=names[i];if(key==='length')continue;if(typeof key!=='string'||!arrayIndex(key,length)){ancestors.length--;return {ok:false};}}
      output=result;
    } else {
      const proto=prototypeOf(input);
      if(proto!==plainPrototype && proto!==null) {ancestors.length--;return {ok:false};}
      const names=ownKeys(input);const result=Object.create(null) as Record<string,unknown>;
      bytes+=2+(names.length>1?names.length-1:0);
      for(let i=0;i<names.length;i++) {
        const key=names[i];if(typeof key!=='string'){ancestors.length--;return {ok:false};}
        const descriptor=ownDescriptor(input,key);
        if(!descriptor || !hasOwn(descriptor,'value') || !descriptor.enumerable) {ancestors.length--;return {ok:false};}
        bytes+=quotedLength(key)+1;
        const child=visit(descriptor.value,depth+1);
        if(!child.ok) {ancestors.length--;return {ok:false};}
        result[key]=child.value;
      }
      output=result;
    }
    ancestors.length--;
    return {ok:bytes<=limit,value:output};
  }
  const checked=visit(value,0);
  if(!checked.ok || bytes>limit) return {ok:false};
  // Structured clone preserves -0; serialized counting above is never stored as memory.
  return {ok:true,value:structuredClone(checked.value),bytes,nodes};
}
function equalAuthority(a: unknown,b: Authority): boolean {
  if(!exactRecord(a,['session_id','project_revision','run_epoch','group_id','owner_id','lease_generation','observed_tick','apply_tick','sequence']))return false;
  return data(a,'session_id')===b.session_id && data(a,'project_revision')===b.project_revision && data(a,'run_epoch')===b.run_epoch &&
    data(a,'group_id')===b.group_id && data(a,'owner_id')===b.owner_id && data(a,'lease_generation')===b.lease_generation &&
    data(a,'observed_tick')===b.observed_tick && data(a,'apply_tick')===b.apply_tick && data(a,'sequence')===b.sequence;
}
function sameKeys(value: unknown,keys: readonly string[]): boolean { return exactRecord(value,keys); }

export async function connectRunner(args: {
  dataPort: MessagePort; lifecyclePort: MessagePort; source: string; sourceId: string;
  identity: {session_id: string; project_revision: string; run_epoch: number}; groupId: string; ownerId: string;
  leaseGeneration: number; timeoutMs: number;
}) {
  if(!args || !args.dataPort || !args.lifecyclePort || typeof args.source!=='string' || args.source.length>131072 || utf8Length(args.source)>131072 ||
    typeof args.sourceId!=='string' || args.sourceId.length<1 || args.sourceId.length>256 ||
    !sameKeys(args.identity,['session_id','project_revision','run_epoch']) || typeof data(args.identity,'session_id')!=='string' || !data(args.identity,'session_id') || (data(args.identity,'session_id') as string).length>256 || !revision(data(args.identity,'project_revision')) ||
    !safeInt(data(args.identity,'run_epoch')) || typeof args.groupId!=='string' || !args.groupId || args.groupId.length>256 || typeof args.ownerId!=='string' || !args.ownerId || args.ownerId.length>256 ||
    !safeInt(args.leaseGeneration,1) || !Number.isFinite(args.timeoutMs) || args.timeoutMs<=0 || args.timeoutMs>60000) throw fault('INVALID_AUTHORITY');
  const identity={session_id:data(args.identity,'session_id') as string,project_revision:data(args.identity,'project_revision') as string,run_epoch:data(args.identity,'run_epoch') as number};
  let closed=false,closing=false,initialized=false,stageInFlight=false,sequence=0,controlWidth=0;
  let pendingStage: {stageId:string;authority:Authority}|undefined;
  let sentCount=0,windowStart=0,termination: Promise<void>|undefined,closePromise: Promise<void>|undefined;
  const outstanding=new Map<string,{resolve:(reply:Reply)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>} >();
  const terminations=new Map<string,()=>void>();

  const closePorts=()=>{try{args.dataPort.close();}catch{}try{args.lifecyclePort.close();}catch{};};
  const terminateInstance=(reason: string): Promise<void>=>{
    if(termination) return termination;
    closed=true;
    termination=new Promise(resolve=>{
      const request_id=crypto.randomUUID();let done=false;
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);terminations.delete(request_id);closePorts();resolve();};
      terminations.set(request_id,finish);
      const timer=setTimeout(finish,Math.min(args.timeoutMs,1000));
      try{args.lifecyclePort.postMessage({version:1,kind:'terminate',request_id,reason});}catch{finish();}
    });
    return termination;
  };
  const failTerminal=async(code: string):Promise<never>=>{await terminateInstance(code);throw fault(code);};

  args.dataPort.onmessage=(event: MessageEvent<Reply>)=>{
    if(closed)return;
    const reply=event.data;
    const requestId=data(reply,'request_id');
    if(typeof requestId!=='string') {void terminateInstance('PROTOCOL_FAULT');return;}
    const waiting=outstanding.get(requestId);
    if(!waiting) {void terminateInstance('PROTOCOL_FAULT');return;}
    outstanding.delete(requestId);clearTimeout(waiting.timer);
    if(data(reply,'kind')==='error') {
      const code=data(reply,'code');
      const allowed=['STAGE_PENDING','CLOSED','INVALID_RESULT','CONTROLLER_FAULT','TIMEOUT','INVALID_AUTHORITY','PROTOCOL_FAULT','NOT_QUALIFIED','STARTUP_FAILED'];
      let known=false;for(let i=0;i<allowed.length;i++)if(code===allowed[i]){known=true;break;}
      if(!exactRecord(reply,['request_id','kind','code']) || !known) {void terminateInstance('PROTOCOL_FAULT');waiting.reject(fault('PROTOCOL_FAULT'));return;}
      waiting.reject(fault(code as string));return;
    }
    waiting.resolve(reply);
  };
  args.dataPort.start();
  args.lifecyclePort.onmessage=(event: MessageEvent)=>{
    const reply=event.data;
    if(!exactRecord(reply,['version','kind','request_id']) || data(reply,'version')!==1 || data(reply,'kind')!=='termination-requested') return;
    const requestId=data(reply,'request_id');if(typeof requestId==='string')terminations.get(requestId)?.();
  };
  args.lifecyclePort.start();

  function rate(): boolean {
    const current=Date.now();
    if(current-windowStart>=rateWindowMs){windowStart=current;sentCount=0;}
    sentCount++;return sentCount<=maxMessagesPerWindow;
  }
  function call(message: Record<string,unknown>): Promise<Reply> {
    if(closed)return Promise.reject(fault('CLOSED'));
    if(!rate())return Promise.reject(fault('PROTOCOL_FAULT'));
    const request_id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        outstanding.delete(request_id);
        void terminateInstance('timeout').then(()=>reject(fault('TIMEOUT')));
      },args.timeoutMs);
      outstanding.set(request_id,{resolve,reject,timer});
      try{args.dataPort.postMessage({...message,request_id});}catch{clearTimeout(timer);outstanding.delete(request_id);reject(fault('CLOSED'));}
    });
  }
  function checkSimpleReply(reply: Reply,kind: string): boolean {
    return exactRecord(reply,['request_id','kind']) && data(reply,'kind')===kind;
  }
  function sendAuthority(value: {observation: Record<string,unknown>;sequence:number;applyTick:number}): Authority {
    return {session_id:identity.session_id,project_revision:identity.project_revision,run_epoch:identity.run_epoch,
      group_id:args.groupId,owner_id:args.ownerId,lease_generation:args.leaseGeneration,
      observed_tick:data(value.observation,'tick') as number,apply_tick:value.applyTick,sequence:value.sequence};
  }
  function validateStageArgs(value: StageArgs): {observation:Record<string,unknown>;intent:unknown;authority:Authority} {
    if(!sameKeys(value,['observation','intent','sequence','applyTick']) || !safeInt(value.sequence,1) || value.sequence!==sequence+1 ||
      !safeInt(value.applyTick) || !sameKeys(value.observation,['session_id','project_revision','run_epoch','tick','sim_time','dt','samples'])) throw fault('INVALID_AUTHORITY');
    const observation=value.observation as Record<string,unknown>;
    const tick=data(observation,'tick');
    if(data(observation,'session_id')!==identity.session_id || data(observation,'project_revision')!==identity.project_revision ||
      data(observation,'run_epoch')!==identity.run_epoch || !safeInt(tick) || value.applyTick!==tick ||
      typeof data(observation,'sim_time')!=='number' || !finite(data(observation,'sim_time')) ||
      typeof data(observation,'dt')!=='number' || !finite(data(observation,'dt'))) throw fault('INVALID_AUTHORITY');
    const safeObservation=boundedClone(observation,maxObservationBytes);const safeIntent=boundedClone(value.intent,maxDiagnosticsBytes);
    if(!safeObservation.ok || !safeIntent.ok)throw fault('INVALID_AUTHORITY');
    const authority=sendAuthority({observation:safeObservation.value as Record<string,unknown>,sequence:value.sequence,applyTick:value.applyTick});
    return {observation:safeObservation.value as Record<string,unknown>,intent:safeIntent.value,authority};
  }

  async function initialize(descriptor: unknown,parameters: unknown):Promise<void> {
    if(closed)throw fault('CLOSED');if(initialized || closing)throw fault('INVALID_AUTHORITY');
    if(!sameKeys(descriptor,['group_id','control_size','inputs','control_stride','observations']) ||
      data(descriptor,'group_id')!==args.groupId || !safeInt(data(descriptor,'control_size'),1)) throw fault('INVALID_AUTHORITY');
    const inputs=data(descriptor,'inputs');
    if(!isArray(inputs) || inputs.length!==data(descriptor,'control_size')) throw fault('INVALID_AUTHORITY');
    const safeDescriptor=boundedClone(descriptor,maxMemoryBytes);const safeParameters=boundedClone(parameters,maxMemoryBytes);
    if(!safeDescriptor.ok || !safeParameters.ok)throw fault('INVALID_AUTHORITY');
    controlWidth=data(descriptor,'control_size') as number;
    try {
      const reply=await call({kind:'initialize',source:args.source,sourceId:args.sourceId,identity:{...identity,group_id:args.groupId,owner_id:args.ownerId,lease_generation:args.leaseGeneration},descriptor:safeDescriptor.value,parameters:safeParameters.value});
      if(!checkSimpleReply(reply,'initialized'))return await failTerminal('PROTOCOL_FAULT');
      initialized=true;
    } catch(error) {
      const code=(error as {code?:string})?.code || 'CONTROLLER_FAULT';
      if(code==='TIMEOUT')throw fault(code);
      if(code==='CLOSED')throw fault(code);
      if(code==='INVALID_AUTHORITY')throw fault(code);
      if(code==='PROTOCOL_FAULT' || code==='CONTROLLER_FAULT' || code==='INVALID_RESULT')return await failTerminal(code);
      throw error;
    }
  }
  async function stage(value: StageArgs):Promise<{stageId:string;control:unknown;diagnostics?:unknown}> {
    if(closed || closing)throw fault('CLOSED');if(!initialized)throw fault('INVALID_AUTHORITY');if(pendingStage || stageInFlight)throw fault('STAGE_PENDING');
    let checked:{observation:Record<string,unknown>;intent:unknown;authority:Authority};
    try{checked=validateStageArgs(value);}catch(error){throw (error as {code?:string})?.code==='INVALID_AUTHORITY'?fault('INVALID_AUTHORITY'):error;}
    const stageId=crypto.randomUUID();
    stageInFlight=true;
    try {
      const reply=await call({kind:'stage',stageId,authority:checked.authority,observation:checked.observation,intent:checked.intent});
      const hasDiagnostics=data(reply,'diagnostics')!==undefined;
      const keys=hasDiagnostics?['request_id','kind','stageId','authority','control','diagnostics']:['request_id','kind','stageId','authority','control'];
      if(!exactRecord(reply,keys) || data(reply,'kind')!=='stage' || data(reply,'stageId')!==stageId || !equalAuthority(data(reply,'authority'),checked.authority)) return await failTerminal('PROTOCOL_FAULT');
      const control=boundedClone(data(reply,'control'),maxMemoryBytes);
      if(!control.ok || !isArray(control.value) || (control.value as unknown[]).length!==controlWidth) return await failTerminal('INVALID_RESULT');
      for(let i=0;i<(control.value as unknown[]).length;i++) if(typeof (control.value as unknown[])[i]!=='number' || !finite((control.value as number[])[i])) return await failTerminal('INVALID_RESULT');
      let diagnostics:unknown;
      if(hasDiagnostics){const safe=boundedClone(data(reply,'diagnostics'),maxDiagnosticsBytes);if(!safe.ok)return await failTerminal('INVALID_RESULT');diagnostics=safe.value;}
      sequence=value.sequence;pendingStage={stageId,authority:checked.authority};
      return hasDiagnostics?{stageId,control:control.value,diagnostics}:{stageId,control:control.value};
    } catch(error) {
      const code=(error as {code?:string})?.code || 'CONTROLLER_FAULT';
      if(code==='INVALID_RESULT' || code==='CONTROLLER_FAULT' || code==='PROTOCOL_FAULT') return await failTerminal(code);
      if(code==='TIMEOUT') throw fault(code);if(code==='CLOSED')throw fault(code);throw error;
    } finally { stageInFlight=false; }
  }
  async function commit(stageId:string):Promise<{stageId:string}> {
    if(closed || closing)throw fault('CLOSED');const pending=pendingStage;
    if(!pending || pending.stageId!==stageId)throw fault('INVALID_AUTHORITY');
    try {
      const reply=await call({kind:'commit',stageId,authority:pending.authority});
      if(!exactRecord(reply,['request_id','kind','stageId','authority']) || data(reply,'kind')!=='committed' || data(reply,'stageId')!==stageId || !equalAuthority(data(reply,'authority'),pending.authority)) return await failTerminal('PROTOCOL_FAULT');
      pendingStage=undefined;return {stageId};
    } catch(error) {
      const code=(error as {code?:string})?.code || 'CONTROLLER_FAULT';
      if(code==='PROTOCOL_FAULT' || code==='CONTROLLER_FAULT' || code==='INVALID_RESULT')return await failTerminal(code);
      if(code==='TIMEOUT')throw fault(code);if(code==='CLOSED')throw fault(code);throw error;
    }
  }
  async function abort(stageId:string):Promise<void> {
    if(closed || closing)throw fault('CLOSED');if(!pendingStage || pendingStage.stageId!==stageId)throw fault('INVALID_AUTHORITY');
    pendingStage=undefined;await terminateInstance('abort');
  }
  function close():Promise<void> {
    if(closePromise)return closePromise;
    closing=true;
    closePromise=(async()=>{
      if(termination){await termination;return;}
      if(closed)return;
      if(initialized) {
        try {
          const reply=await call({kind:'dispose'});
          if(!checkSimpleReply(reply,'disposed'))return await failTerminal('PROTOCOL_FAULT');
        } catch(error) {
          const code=(error as {code?:string})?.code || 'CONTROLLER_FAULT';
          await terminateInstance(code);
          throw fault(code);
        }
      }
      await terminateInstance('close');
    })();
    return closePromise;
  }
  return {initialize,stage,commit,abort,close};
}

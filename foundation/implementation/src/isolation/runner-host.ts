type AuthorityOwner = {dataPort: MessagePort; lifecyclePort: MessagePort; close(): Promise<void>};
type TerminationMessage = {version: 1; kind: 'terminate'; request_id: string; reason?: string};
type TerminationReply = {version: 1; kind: 'termination-requested'; request_id: string};
type ReadyMessage = {version: 1; kind: 'c1-frame-ready'; challenge: string};

const apply = Reflect.apply;
const getDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const randomUUID = crypto.randomUUID.bind(crypto);

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = getDescriptor(value,key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor,'value') ? descriptor.value : undefined;
}
function exactMessage(value: unknown, keys: readonly string[]): boolean {
  if (value === null || typeof value !== 'object') return false;
  const names=ownKeys(value);
  if (names.length !== keys.length) return false;
  for(let i=0;i<names.length;i++) {
    if(typeof names[i] !== 'string') return false;
    let found=false;
    for(let j=0;j<keys.length;j++) if(names[i]===keys[j]) {found=true;break;}
    const descriptor=getDescriptor(value,names[i] as string);
    if(!found || !descriptor || !Object.prototype.hasOwnProperty.call(descriptor,'value') || !descriptor.enumerable) return false;
  }
  return true;
}
function asError(code: string): Error { return Object.assign(new Error(code),{code}); }

/** Owns the app-side frame, data channel, and independent termination channel. */
export async function openRunnerFrame(args: {
  mount: HTMLElement; runnerOrigin: string; frameURL: string; timeoutMs: number;
}): Promise<AuthorityOwner> {
  const {mount,runnerOrigin,frameURL,timeoutMs}=args;
  let origin: string; let frameUrl: URL;
  try { origin=new URL(runnerOrigin).origin; frameUrl=new URL(frameURL); }
  catch { throw asError('STARTUP_FAILED'); }
  if(!Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>60000 || !mount || origin!==runnerOrigin ||
    frameUrl.origin!==origin || origin===location.origin || frameUrl.pathname!=='/frame' || frameUrl.search || frameUrl.hash ||
    frameUrl.username || frameUrl.password) throw asError('STARTUP_FAILED');

  // Credentialless is a native iframe capability, not a writable feature flag.
  // Require its prototype accessor and prove its getter observes the set operation
  // before creating any channel, frame request, or worker. Otherwise fail closed.
  const credentiallessDescriptor=getDescriptor(HTMLIFrameElement.prototype,'credentialless');
  if(!credentiallessDescriptor || typeof credentiallessDescriptor.get!=='function' || typeof credentiallessDescriptor.set!=='function')
    throw asError('NOT_QUALIFIED');
  const challenge=randomUUID();
  frameUrl.searchParams.set('challenge',challenge);
  const frame=document.createElement('iframe') as HTMLIFrameElement & {credentialless: boolean};
  apply(credentiallessDescriptor.set,frame,[true]);
  if(apply(credentiallessDescriptor.get,frame,[])!==true || getDescriptor(frame,'credentialless')!==undefined)
    throw asError('NOT_QUALIFIED');
  frame.sandbox='allow-scripts allow-same-origin';
  frame.referrerPolicy='no-referrer';
  frame.src=frameUrl.href;
  const data=new MessageChannel();
  const control=new MessageChannel();
  const lifecycle=new MessageChannel();
  let disposal: Promise<void> | undefined;
  const awaitingControl=new Map<string,(reply:TerminationReply)=>void>();
  const closePort=(port: MessagePort) => { try { port.close(); } catch {} };

  const ready=new Promise<void>((resolve,reject)=>{
    let settled=false;
    const finish=(error?: Error)=>{
      if(settled) return; settled=true; clearTimeout(timer); removeEventListener('message',receive);
      if(error) reject(error); else resolve();
    };
    const timer=setTimeout(()=>finish(asError('STARTUP_FAILED')),timeoutMs);
    const receive=(event: MessageEvent<ReadyMessage>)=>{
      if(event.source!==frame.contentWindow || event.origin!==origin || event.ports.length!==0 ||
        !exactMessage(event.data,['version','kind','challenge']) || ownData(event.data,'version')!==1 ||
        ownData(event.data,'kind')!=='c1-frame-ready' || ownData(event.data,'challenge')!==challenge) return;
      finish();
    };
    addEventListener('message',receive);
    frame.addEventListener('error',()=>finish(asError('STARTUP_FAILED')),{once:true});
    mount.append(frame);
  });
  try {
    await ready;
    frame.contentWindow!.postMessage({version:1,kind:'c1-bootstrap',challenge},origin,[data.port2,control.port2]);
  } catch(error) {
    closePort(data.port1);closePort(data.port2);closePort(control.port1);closePort(control.port2);
    closePort(lifecycle.port1);closePort(lifecycle.port2);frame.remove();throw error;
  }

  const requestTermination=(request: TerminationMessage): Promise<TerminationReply|undefined>=>new Promise(resolve=>{
    let done=false;
    const finish=(reply?:TerminationReply)=>{if(done)return;done=true;clearTimeout(timer);awaitingControl.delete(request.request_id);resolve(reply);};
    awaitingControl.set(request.request_id,finish as (reply:TerminationReply)=>void);
    const timer=setTimeout(()=>finish(),timeoutMs);
    try { control.port1.postMessage(request); } catch { finish(); }
  });
  control.port1.onmessage=(event: MessageEvent<TerminationReply>)=>{
    const reply=event.data;
    if(!exactMessage(reply,['version','kind','request_id']) || ownData(reply,'version')!==1 ||
      ownData(reply,'kind')!=='termination-requested' || typeof ownData(reply,'request_id')!=='string') return;
    const requestId=ownData(reply,'request_id') as string;
    const finish=awaitingControl.get(requestId);
    if(!finish) return;
    finish(reply);
    try { lifecycle.port2.postMessage(reply); } catch {}
  };
  control.port1.start();
  lifecycle.port2.onmessage=(event: MessageEvent<TerminationMessage>)=>{
    const request=event.data;
    if(!exactMessage(request,['version','kind','request_id','reason']) && !exactMessage(request,['version','kind','request_id'])) return;
    if(ownData(request,'version')!==1 || ownData(request,'kind')!=='terminate' ||
      typeof ownData(request,'request_id')!=='string' || (ownData(request,'reason')!==undefined && typeof ownData(request,'reason')!=='string')) return;
    void requestTermination(request as TerminationMessage);
  };
  lifecycle.port2.start();
  const dispose=(): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async()=>{
      try {
        const request_id=randomUUID();
        await requestTermination({version:1,kind:'terminate',request_id,reason:'owner-close'});
        frame.remove();
      } finally {
        closePort(data.port1);closePort(control.port1);closePort(lifecycle.port1);
        closePort(control.port2);closePort(lifecycle.port2);closePort(data.port2);
      }
    })();
    return disposal;
  };
  return {dataPort:data.port1,lifecyclePort:lifecycle.port1,close:dispose};
}

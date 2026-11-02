// Static runner-origin handshake. This frame receives no controller source and
// transfers the data channel only to its one dedicated worker.
declare const __BRF_APP_ORIGIN__: string;
type Bootstrap = {version: number; kind: string; challenge: string};
type ControlMessage = {version: number; kind: string; request_id: string; reason?: string};
const appOrigin=__BRF_APP_ORIGIN__;
const challenge=new URL(location.href).searchParams.get('challenge');
const NativeWorker=Worker;
const terminateWorker=Worker.prototype.terminate;
const portPost=MessagePort.prototype.postMessage;
const portStart=MessagePort.prototype.start;
const portClose=MessagePort.prototype.close;
const apply=Reflect.apply;
const ownDescriptor=Object.getOwnPropertyDescriptor;
const ownKeys=Reflect.ownKeys;
function ownValue(value: unknown,key: string): unknown {
  if(value===null || typeof value!=='object') return undefined;
  const desc=ownDescriptor(value,key);
  return desc && Object.prototype.hasOwnProperty.call(desc,'value') ? desc.value : undefined;
}
function isExact(value: unknown,keys: readonly string[]): boolean {
  if(value===null || typeof value!=='object') return false;
  const names=ownKeys(value);
  if(names.length!==keys.length) return false;
  for(let i=0;i<names.length;i++) {
    if(typeof names[i]!=='string') return false;
    let found=false;
    for(let j=0;j<keys.length;j++) if(names[i]===keys[j]) {found=true;break;}
    const desc=ownDescriptor(value,names[i] as string);
    if(!found || !desc || !Object.prototype.hasOwnProperty.call(desc,'value') || !desc.enumerable) return false;
  }
  return true;
}
function closeTransferred(ports: readonly MessagePort[]): void {
  for(let i=0;i<ports.length;i++) { try { apply(portClose,ports[i],[]); } catch {} }
}
if(challenge && challenge.length>0 && challenge.length<=128 && location.origin!==appOrigin) {
  let consumed=false;
  const receive=(event: MessageEvent<Bootstrap>)=>{
    const data=event.data;
    // Wrong window/origin/challenge is ignored, leaving the legitimate one-shot intact.
    if(consumed || event.source!==parent || event.origin!==appOrigin || ownValue(data,'challenge')!==challenge) return;
    // A matching authenticated parent consumes the one-shot even when malformed.
    consumed=true;
    removeEventListener('message',receive);
    if(!isExact(data,['version','kind','challenge']) || ownValue(data,'version')!==1 ||
       ownValue(data,'kind')!=='c1-bootstrap' || event.ports.length!==2) { closeTransferred(event.ports); return; }
    const dataPort=event.ports[0];
    const controlPort=event.ports[1];
    const worker=new NativeWorker('/runner.js',{type:'module',name:'brf-runner'});
    worker.postMessage({kind:'c1-connect',port:dataPort},[dataPort]);
    controlPort.onmessage=(message: MessageEvent<ControlMessage>)=>{
      const request=message.data;
      if(!isExact(request,['version','kind','request_id','reason']) && !isExact(request,['version','kind','request_id'])) return;
      if(ownValue(request,'version')!==1 || ownValue(request,'kind')!=='terminate' ||
        typeof ownValue(request,'request_id')!=='string' ||
        (ownValue(request,'reason')!==undefined && typeof ownValue(request,'reason')!=='string')) return;
      apply(terminateWorker,worker,[]);
      apply(portPost,controlPort,[{version:1,kind:'termination-requested',request_id:ownValue(request,'request_id')}]);
    };
    apply(portStart,controlPort,[]);
  };
  addEventListener('message',receive);
  parent.postMessage({version:1,kind:'c1-frame-ready',challenge},appOrigin);
}

type SessionState = 'ready-paused' | 'running' | 'paused' | 'faulted' | 'disposed';
type SessionIdentity = Readonly<{session_id:string; project_revision:string; run_epoch:number}>;
type Session = {readonly identity:SessionIdentity; readonly state:SessionState; submit(command:unknown):Promise<unknown>};
type Button = Pick<HTMLButtonElement, 'disabled' | 'addEventListener' | 'removeEventListener'>;
type Controls = {run:Button; pause:Button; step:Button; play:Button; research:Button; status:Pick<HTMLElement,'textContent'>; researchStep?:Button; researchStepCount?:Pick<HTMLInputElement,'value'>};
type SurfaceHost = {readonly session:Session; setSurface(surface:'play'|'research'):void};

export function createSessionControls({session, surfaceHost, controls, beforeResearchStep, afterStep, afterPause, beforeAdvance}:{session:Session; surfaceHost:SurfaceHost; controls:Controls; beforeResearchStep?:()=>void; afterStep?:(result:unknown)=>void; afterPause?:(result:unknown)=>void; beforeAdvance?:()=>void}) {
  if (!session || !surfaceHost || surfaceHost.session !== session || !controls || typeof session.submit !== 'function' || typeof surfaceHost.setSurface !== 'function') throw new Error('Invalid session controls');
  const {run,pause,step,play,research,status,researchStep,researchStepCount}=controls;
  const buttons=[run,pause,step,play,research,...(researchStep?[researchStep]:[])];
  if (!status || Boolean(researchStep)!==Boolean(researchStepCount) || (beforeResearchStep!==undefined && typeof beforeResearchStep!=='function') || (afterStep!==undefined && typeof afterStep!=='function') || (afterPause!==undefined && typeof afterPause!=='function') || (beforeAdvance!==undefined && typeof beforeAdvance!=='function') || buttons.some(button=>!button || typeof button.addEventListener!=='function' || typeof button.removeEventListener!=='function') || new Set(buttons).size!==buttons.length) throw new Error('Invalid session controls');
  let disposed=false, stepPending=false, runPending=false, pausePending=false, attemptBusy=false;
  let runStartTimer:ReturnType<typeof setTimeout>|null=null;
  type Report={token:object;kind:'run'|'pause'|'step';message:string;count:number|null;unknown:boolean};
  let diagnostic:{identity:SessionIdentity;reports:Report[]}|null=null;
  const same=(a:SessionIdentity,b:SessionIdentity)=>!!a && !!b && a.session_id===b.session_id && a.project_revision===b.project_revision && a.run_epoch===b.run_epoch;
  function update(message?:string) {
    if (disposed) return;
    const state=session.state;
    if(diagnostic && (state!=='faulted' || !same(diagnostic.identity,session.identity))) diagnostic=null;
    const unavailable=state==='disposed' || state==='faulted';
    run.disabled=unavailable || attemptBusy || stepPending || runPending || state==='running' || pausePending;
    step.disabled=unavailable || attemptBusy || stepPending || runPending || state==='running' || pausePending;
    if(researchStep) researchStep.disabled=step.disabled;
    pause.disabled=unavailable || attemptBusy || stepPending || pausePending || state!=='running';
    status.textContent=(state==='faulted' && diagnostic ? formatReports(diagnostic.reports) : message ?? (state==='disposed' ? 'Session disposed' : state==='faulted' ? 'Session needs attention' : state==='running' ? 'Running' : 'Paused')).slice(0,256);
  }
  function describe(error:unknown,kind:'run'|'pause'|'step',steps:number,token:object):Report {
    let message='Command failed',count:unknown,unknown:unknown;
    try {
      if(error instanceof Error && typeof error.message==='string' && error.message)message=error.message;
      if(error && typeof error==='object') {
        const c=Object.getOwnPropertyDescriptor(error,'steps_completed'),u=Object.getOwnPropertyDescriptor(error,'outcome_unknown');
        if(c && Object.hasOwn(c,'value'))count=c.value;
        if(u && Object.hasOwn(u,'value'))unknown=u.value;
      }
    } catch {message='Command failed';}
    const valid=Number.isSafeInteger(count) && (count as number)>=0 && (kind!=='step' || (count as number)<=steps);
    return {token,kind,message:message.replace(/[\r\n]/g,' ').slice(0,256),count:valid?count as number:null,unknown:unknown===true};
  }
  const substantive=(report:Report)=>report.unknown || report.count!==null;
  function formatReports(reports:Report[]):string {
    const heads=reports.map(report=>{
      let head=`${report.kind[0].toUpperCase()+report.kind.slice(1)}: `;
      if(report.unknown)head+='Outcome unknown. ';
      if(report.count!==null)head+=`Reported completed steps: ${report.count}. `;
      return head;
    });
    let remaining=256-heads.reduce((sum,head)=>sum+head.length,0)-(reports.length-1);
    return reports.map((report,index)=>{
      const share=Math.max(0,Math.floor(remaining/(reports.length-index)));
      const body=report.message.slice(0,share);remaining-=body.length;
      return heads[index]+body;
    }).join('\n');
  }
  function record(identity:SessionIdentity, report:Report) {
    if(!diagnostic || !same(diagnostic.identity,identity)) diagnostic={identity,reports:[]};
    const existing=diagnostic.reports;
    if(substantive(report)) {
      const kept=existing.filter(substantive);
      if(kept.length<2)kept.push(report);
      diagnostic.reports=kept;
    } else if(existing.length===0) existing.push(report);
  }
  function watchRunStart() {
    if(disposed || !runPending)return;
    if(session.state==='running'){runStartTimer=null;update();return;}
    runStartTimer=setTimeout(watchRunStart,25);
  }
  async function command(kind:'run'|'pause'|'step', steps=1, isResearch=false) {
    if (disposed || attemptBusy) return;
    const state=session.state;
    if (state==='disposed' || state==='faulted') {update();return;}
    if ((kind==='step' || kind==='run') && (stepPending || runPending || pausePending || state==='running')) {update();return;}
    if (kind==='pause' && (state!=='running' || stepPending || pausePending)) {update();return;}
    if (kind==='step') stepPending=true;
    if (kind==='run') runPending=true;
    if (kind==='pause') pausePending=true;
    let identity:SessionIdentity|null=null;
    const operationToken=Object.freeze({});
    const stillSame=()=>{try {return identity!==null && same(identity,session.identity);} catch {return false;}};
    try {
      const currentIdentity=session.identity;
      identity={session_id:currentIdentity.session_id,project_revision:currentIdentity.project_revision,run_epoch:currentIdentity.run_epoch};
      if(kind==='run'||kind==='step')beforeAdvance?.();
      if(isResearch)beforeResearchStep?.();
      if(disposed || !same(identity,session.identity) || session.state==='disposed' || session.state==='faulted')return;
      const input={kind,...identity,...(kind==='step'?{steps}:{})};
      const operation=session.submit(input);
      if(kind==='run' && session.state!=='running'){update('Waiting for target...');watchRunStart();}else update();
      const result=await operation;
      if (!disposed && stillSame()) {update();if(kind==='step')try{afterStep?.(result)}catch{/* presentation cannot fail the step */}if(kind==='pause')try{afterPause?.(result)}catch{/* presentation cannot fail the pause */}}
    } catch (error) {
      if (!disposed && identity && stillSame()) {
        const report=describe(error,kind,steps,operationToken);
        if(session.state==='faulted')record(identity,report);
        update(formatReports([report]));
      } else if (!disposed && !identity) update('Session identity unavailable');
    } finally {
      if (kind==='step') stepPending=false;
      if (kind==='run') {runPending=false;if(runStartTimer!==null){clearTimeout(runStartTimer);runStartTimer=null;}}
      if (kind==='pause') pausePending=false;
      if (!disposed) {
        const message=!identity || stillSame() ? status.textContent ?? '' : undefined;
        update(message);
      }
    }
  }
  const onRun=()=>{void command('run');}, onPause=()=>{void command('pause');}, onStep=()=>{void command('step');};
  const onResearchStep=()=>{
    if(disposed || attemptBusy)return;
    if(session.state==='faulted' || session.state==='disposed') {update();return;}
    if(stepPending || runPending || pausePending || session.state==='running'){update();return;}
    const value=researchStepCount?.value;
    if(typeof value!=='string' || !/^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(value)){update('Step count must be a whole number from 1 to 64.');return;}
    void command('step',Number(value),true);
  };
  function switchTo(surface:'play'|'research') {if (disposed) return; try {surfaceHost.setSurface(surface);update();} catch (error) {update(error instanceof Error ? error.message : 'Unable to switch surface');}}
  const onPlay=()=>switchTo('play'), onResearch=()=>switchTo('research');
  run.addEventListener('click',onRun);pause.addEventListener('click',onPause);step.addEventListener('click',onStep);play.addEventListener('click',onPlay);research.addEventListener('click',onResearch);researchStep?.addEventListener('click',onResearchStep);
  update();
  return Object.freeze({setAttemptBusy(value:boolean) {if (!disposed) {attemptBusy=value; update();}}, reconcileFault(identity:SessionIdentity) {if (!disposed && session.state==='faulted' && same(identity,session.identity) && !disposed) update();}, dispose() {if (disposed) return; disposed=true;diagnostic=null;if(runStartTimer!==null){clearTimeout(runStartTimer);runStartTimer=null;}run.removeEventListener('click',onRun);pause.removeEventListener('click',onPause);step.removeEventListener('click',onStep);play.removeEventListener('click',onPlay);research.removeEventListener('click',onResearch);researchStep?.removeEventListener('click',onResearchStep);}});
}

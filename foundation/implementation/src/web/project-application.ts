import {replayTargetSchedule} from '../../../../replay-target-schedule.mjs';
import {mountProjectInspector, type ProjectInspectorConfig} from './project-inspector.ts';
import {createProjectOpener} from './project-opener.ts';
import {mountSessionShell} from './session-shell.ts';
import {copyBounded} from '../session/project-world-wire.ts';
import {validateTrustedRecordingPolicy} from '../session/trusted-recording-policy.ts';
import {readSourceMaterialFailure} from '../session/project-world-manager.ts';

type Resolver = (revision: string) => unknown | Promise<unknown>;
type Opener = ReturnType<typeof createProjectOpener>;
type Shell = ReturnType<typeof mountSessionShell>;
type Session = Awaited<ReturnType<Opener['open']>>;
type Goal = {inventory: unknown; attempt:number; revision:string; goal:string|null; welcome:string|null; schematic:boolean; simpleDuck:boolean; tutorial:boolean; turnGoal:{body:string;min_radians:number}|null; targetLabels:readonly {group_id:string;field:string;label:string}[]};
type Phase = 'reserved' | 'opening' | 'mounting' | 'published' | 'cleaning' | 'retired';
type Run = {opener: Opener | null; shell: Shell | null; session:Session|null; selected:unknown; sessionId:string|null; revision:string|null; cancelled: boolean; phase: Phase;
  done: Promise<void>; finish: () => void; cleanup: Promise<void> | null; early: Promise<void> | null};

// Trusted deployment operators may explicitly edit and review this source-owned
// registry. Captured project bytes and ambient browser state never supply it.
const TRUSTED_PROJECT_DECISIONS: readonly unknown[] = [];
const REGISTRY_BUDGET = 1048576;
type TrustedConfiguration = {resolveTrusted: Resolver};

function exactFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value,key)) &&
    keys.every(key => required.includes(key) || optional.includes(key));
}

/** Snapshot a bounded operator-owned registry; actual session admission remains separate. */
export function createTrustedOpeningConfiguration(records: unknown): TrustedConfiguration | null {
  try {
    if (!Array.isArray(records)) throw new Error('Invalid records');
    const length = Object.getOwnPropertyDescriptor(records, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 256) throw new Error('Invalid record count');
    const owned = copyBounded(records, REGISTRY_BUDGET);
    const byRevision = new Map<string, unknown>();
    for (const row of owned) {
      if (!exactFields(row,['project_revision','profile','controllers','runnerOrigin','frameURL','policy']) ||
          typeof row.project_revision !== 'string' || !/^[0-9a-f]{64}$/.test(row.project_revision) ||
          !row.profile || typeof row.profile !== 'object' || Array.isArray(row.profile) ||
          !Array.isArray(row.controllers) || typeof row.runnerOrigin !== 'string' || !row.runnerOrigin ||
          typeof row.frameURL !== 'string' || !row.frameURL ||
          !exactFields(row.policy,['inventoryLimits','compileLimits','timeoutMs','maxReplyBytes','frameTimeoutMs','approvedGrants'],['wasmUrl','approvedRecordingGrants']) ||
          !row.policy.inventoryLimits || typeof row.policy.inventoryLimits !== 'object' || Array.isArray(row.policy.inventoryLimits) ||
          !row.policy.compileLimits || typeof row.policy.compileLimits !== 'object' || Array.isArray(row.policy.compileLimits) ||
          !Array.isArray(row.policy.approvedGrants) ||
          byRevision.has(row.project_revision)) throw new Error('Invalid decision');
      if (Object.hasOwn(row.policy,'approvedRecordingGrants')) validateTrustedRecordingPolicy(row.policy.approvedRecordingGrants,row.project_revision);
      byRevision.set(row.project_revision,row);
    }
    if (byRevision.size === 0) return null;
    return Object.freeze({resolveTrusted(revision: string) {
      const row = byRevision.get(revision);
      return row === undefined ? null : copyBounded(row, REGISTRY_BUDGET);
    }});
  } catch { throw new Error('Invalid trusted opening configuration'); }
}

export function getTrustedOpeningConfiguration(): TrustedConfiguration | null {
  return createTrustedOpeningConfiguration(TRUSTED_PROJECT_DECISIONS);
}

export function mountProjectApplication(options: {root: HTMLElement; chooseDirectory: ProjectInspectorConfig['chooseDirectory'];
  folderLimits: ProjectInspectorConfig['folderLimits']; inventoryLimits: ProjectInspectorConfig['inventoryLimits'];
  resolveTrusted: Resolver | null; onSessionPublished?:()=>void; compactPresentation?:boolean; publishedDuckAssetURL?:string}) {
  const {root, chooseDirectory, folderLimits, inventoryLimits, resolveTrusted, onSessionPublished, compactPresentation=false, publishedDuckAssetURL} = options;
  if (!root || !root.ownerDocument || typeof root.appendChild !== 'function' ||
      typeof chooseDirectory !== 'function' || (resolveTrusted !== null && typeof resolveTrusted !== 'function')) {
    throw new Error('Invalid project application');
  }
  const doc = root.ownerDocument;
  const container = doc.createElement('section'), inspectRoot = doc.createElement('div'),
    start = doc.createElement('button'), close = doc.createElement('button'),
    status = doc.createElement('p'), activeSource = doc.createElement('p'), runnerRoot = doc.createElement('div'), shellRoot = doc.createElement('div');
  for (const [element, role] of [[container,'project-application'],[start,'app-start'],[close,'app-close'],
    [status,'app-status'],[activeSource,'app-active-source'],[runnerRoot,'app-runner'],[shellRoot,'app-shell']] as const) element.setAttribute('data-brf',role);
  start.setAttribute('type','button'); close.setAttribute('type','button');
  start.textContent='Start project'; close.textContent='Close project'; status.setAttribute('role','status');
  status.textContent=resolveTrusted ? 'Inspect a project to start.' : 'Opening requires trusted host configuration.';
  activeSource.textContent='No open session.';
  if (compactPresentation) {
    const details=doc.createElement('details'),summary=doc.createElement('summary');
    details.setAttribute('data-brf','project-details');summary.textContent='Project and experiments';
    details.append(summary,inspectRoot,start,close,activeSource);
    container.append(runnerRoot,status,shellRoot,details);
  } else container.append(inspectRoot,start,close,status,activeSource,runnerRoot,shellRoot);
  let inspector: ReturnType<typeof mountProjectInspector> | null = null;
  let active: Run | null = null, disposed = false, failed = false, disposal: Promise<void> | null = null;
  let overview:Goal|null = null, autoAttempt:number|null = null;
  function syncGoal() {
    const run=active, shell=run?.shell, session=run?.session;
    if(disposed || !run || run.cancelled || run.phase!=='published' || !shell || !session) return;
    let current:unknown, id:Session['identity'];
    try {current=inspector?.selectedProject;id=session.identity;} catch {return;}
    if(disposed || active!==run || run.cancelled || run.phase!=='published' || run.shell!==shell || run.session!==session) return;
    const goal=overview;
    const valid=!!goal && current===run.selected && goal.inventory===run.selected && goal.revision===run.revision &&
      id.session_id===run.sessionId && id.project_revision===run.revision && typeof goal.goal==='string' && goal.goal.length>0 && goal.goal.length<=240;
    shell.setProjectGoal?.(valid ? {attempt:goal!.attempt,session_id:run.sessionId!,project_revision:run.revision!,goal:goal!.goal!,welcome:goal!.welcome,schematic:goal!.schematic,simpleDuck:goal!.simpleDuck,targetLabels:goal!.targetLabels,tutorial:goal!.tutorial,turnGoal:goal!.turnGoal} : null);
  }
  function observeOverview(event:{kind:'selected'|'overview';attempt:number;revision:string;goal?:string|null;welcome?:string|null;schematic?:boolean;simpleDuck?:boolean;tutorial?:boolean;turnGoal?:{body:string;min_radians:number}|null;targetLabels?:readonly {group_id:string;field:string;label:string}[]}) {
    if(disposed)return;
    const currentInspector=inspector;
    let inventory:unknown;
    try {inventory=currentInspector?.selectedProject;} catch {return;}
    if(disposed || inspector!==currentInspector) return;
    if(event.kind==='selected') {
      overview=inventory && Number.isSafeInteger(event.attempt) && event.attempt>0 &&
        typeof event.revision==='string' && (inventory as any).project_revision===event.revision ?
        {inventory,attempt:event.attempt,revision:event.revision,goal:null,welcome:null,schematic:false,simpleDuck:false,tutorial:false,turnGoal:null,targetLabels:[]}:null;
    } else if(event.kind==='overview' && overview && overview.inventory===inventory &&
      overview.attempt===event.attempt && overview.revision===event.revision) {
      overview.goal=typeof event.goal==='string' && event.goal.length>0 && event.goal.length<=240 ? event.goal:null;
      overview.welcome=typeof event.welcome==='string' && event.welcome.length>0 && event.welcome.length<=1200 ? event.welcome:null;
      overview.schematic=event.schematic===true;overview.simpleDuck=event.simpleDuck===true;overview.tutorial=event.tutorial===true;overview.turnGoal=event.turnGoal??null;
      overview.targetLabels=Array.isArray(event.targetLabels)?event.targetLabels:[];
    }
    syncGoal();
    if(!disposed)update();
    if(event.kind==='selected' && autoAttempt===event.attempt) {
      autoAttempt=null;
      queueMicrotask(()=>{if(!disposed && !failed && !active && inspector?.selectedProject===inventory)startRun();});
    }
  }
  function update() {
    if (disposed) return;
    const run=active, currentInspector=inspector;
    let selected:any;
    try {selected=currentInspector?.selectedProject ?? null;} catch {return;}
    if (disposed || inspector!==currentInspector || active!==run) return;
    start.disabled = failed || !resolveTrusted || !!run || !selected;
    close.disabled = !run;
    if (!run || run.cancelled || run.phase!=='published' || !run.session || !run.revision || !run.sessionId) {
      activeSource.textContent='No open session.';
      return;
    }
    const session=run.session, revision=run.revision, sessionId=run.sessionId;
    let selectedRevision:unknown, identity:Session['identity'];
    try {selectedRevision=selected?.project_revision;identity=session.identity;} catch {return;}
    if (disposed || inspector!==currentInspector || active!==run || run.cancelled || run.phase!=='published' ||
        run.session!==session || run.revision!==revision || run.sessionId!==sessionId ||
        identity.session_id!==sessionId || identity.project_revision!==revision) return;
    let confirmed:unknown;
    try {confirmed=currentInspector?.selectedProject ?? null;} catch {return;}
    if (disposed || inspector!==currentInspector || active!==run || run.cancelled || run.phase!=='published' ||
        run.session!==session || run.revision!==revision || run.sessionId!==sessionId || confirmed!==selected) return;
    activeSource.textContent=`Open session source revision: ${revision}.` +
      (typeof selectedRevision==='string' && selectedRevision!==revision ?
        ` Inspected source revision: ${selectedRevision}. This is not the open session; close it before attempting a new start. Host authorization still applies.` : '');
  }
  function clean(run: Run): Promise<void> {
    if (run.cleanup) return run.cleanup;
    run.cleanup = Promise.resolve().then(async () => {
      await run.done;
      run.phase = 'cleaning';
      let error = false;
      if (run.shell) {const shell = run.shell; run.shell = null; try {await shell.dispose();} catch {error = true;}}
      if (run.opener) {const opener = run.opener; run.opener = null; try {await (run.early ?? opener.dispose());} catch {error = true;}}
      run.phase = 'retired';
      if (error) {failed = true; throw new Error('Project cleanup failed');}
    });
    return run.cleanup;
  }
  function cancelOpening(run: Run) {
    run.cancelled = true;
    if (run.phase !== 'opening' || !run.opener || run.early) return;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    run.early = new Promise<void>((yes,no) => {resolve = yes; reject = no;});
    void run.early.catch(() => {});
    try {void run.opener.dispose().then(resolve,reject);} catch (error) {reject(error);}
  }
  function closeRun() {
    const run = active;
    if (!run) return;
    cancelOpening(run);
    status.textContent = 'Closing project?'; update();
    void clean(run).then(() => {
      if (active === run) active = null;
      if (!disposed) {status.textContent = 'Project closed.'; update();}
    }, () => {
      failed = true;
      if (!disposed) {status.textContent = 'Project cleanup failed.'; update();}
    });
  }
  function startRun() {
    if (disposed || failed || active || !resolveTrusted || !inspector) return;
    let finish!: () => void;
    const done = new Promise<void>(resolve => {finish = resolve;});
    const run: Run = {opener:null,shell:null,session:null,selected:null,sessionId:null,revision:null,cancelled:false,phase:'reserved',done,finish,cleanup:null,early:null};
    active = run; update();
    const selected = inspector.selectedProject;
    if (!selected || disposed || run.cancelled) {
      run.finish(); active = null; update(); return;
    }
    run.selected=selected;
    status.textContent = 'Starting project?';
    void (async () => {
      let ok = false;
      let sourceError: unknown = null;
      try {
        run.phase = 'opening';
        run.opener = createProjectOpener({getSelected: () => inspector?.selectedProject ?? null, resolveTrusted, mount:runnerRoot});
        if (disposed || run.cancelled || active !== run) throw new Error('Selection changed');
        const session = await run.opener.open();
        const identity=session.identity;
        run.session=session;run.sessionId=identity.session_id;run.revision=identity.project_revision;
        if (disposed || run.cancelled || active !== run) throw new Error('Selection changed');
        const selectedAfterOpen = inspector?.selectedProject;
        if (disposed || run.cancelled || active !== run || selectedAfterOpen !== selected) throw new Error('Selection changed');
        run.phase = 'mounting';
        run.shell = mountSessionShell({root:shellRoot,session,comparisonInventoryLimits:inventoryLimits,publishedDuckAssetURL});
        if (disposed || run.cancelled || active !== run) throw new Error('Selection changed');
        const selectedAfterMount = inspector?.selectedProject;
        if (disposed || run.cancelled || active !== run || selectedAfterMount !== selected) throw new Error('Selection changed');
        run.phase = 'published'; ok = true; status.textContent = 'Project open.'; syncGoal();
        try {onSessionPublished?.();} catch { /* A presentation observer cannot alter session admission. */ }
      } catch (error) {
        sourceError=error;
        if (!disposed && !run.cancelled && active===run) status.textContent = 'Project start failed.';
      } finally {run.finish();}
      if (!ok) {
        try {
          await clean(run);
          const facts=readSourceMaterialFailure(sourceError);
          let current=false;
          try {current=!disposed && !run.cancelled && active===run && inspector?.selectedProject===selected &&
            !!facts && facts.project_revision===(selected as any)?.project_revision;} catch {current=false;}
          if(current && facts) status.textContent=`Project start failed. This model contains OBJ material declarations that the pinned MuJoCo decoder would ignore if opened; appearance may differ. Affected files: ${facts.asset_notices.map((row:any)=>row.path).join(', ')}.`;
          if (active === run) active = null;
        }
        catch {failed = true; if (!disposed) status.textContent = 'Project cleanup failed.';}
      }
      if (!disposed) update();
    })();
  }
  start.addEventListener('click',startRun); close.addEventListener('click',closeRun);
  try {
    inspector = mountProjectInspector({root:inspectRoot,chooseDirectory,folderLimits,inventoryLimits,
      onSelectionCleared:()=>{overview=null;syncGoal();update();},
      replaySavedTargets:async(inventory,content,endTick)=>{
        const run=active,session=run?.session;
        if(disposed||!run||run.cancelled||run.phase!=='published'||run.revision!==inventory.project_revision||!session||inspector?.selectedProject!==inventory)throw Error('Saved schedule unavailable');
        const identity=session.identity;
        const history=await session.inspectTargetHistory(content,endTick);
        if(disposed||active!==run||run.cancelled||run.session!==session||inspector?.selectedProject!==inventory||
          session.identity.session_id!==identity.session_id||session.identity.run_epoch!==identity.run_epoch)throw Error('Session changed during inspection');
        const result=await replayTargetSchedule(session,history,endTick);
        if(disposed||active!==run||run.cancelled||run.session!==session||inspector?.selectedProject!==inventory||
          session.identity.session_id!==identity.session_id||session.identity.run_epoch!==identity.run_epoch)return {status:'unknown',last_verified_tick:result.last_verified_tick};
        return result;
      },
      applySavedTarget:async(inventory,target)=>{
        const run=active,session=run?.session;
        if(disposed||!run||run.cancelled||run.phase!=='published'||run.revision!==inventory.project_revision||!session||inspector?.selectedProject!==inventory)throw Error('Saved target unavailable');
        const identity=session.identity;
        const result=await session.setTarget(target);
        if(disposed||active!==run||run.cancelled||run.session!==session||inspector?.selectedProject!==inventory||
          session.identity.session_id!==identity.session_id||session.identity.run_epoch!==identity.run_epoch)return {status:'unknown'};
        return result;
      },
      captureSessionGame:(inventory)=>{
        const run=active,shell=run?.shell,session=run?.session;
        if(disposed||!run||run.cancelled||run.phase!=='published'||run.revision!==inventory.project_revision||!shell||!session)return null;
        const game=shell.captureGameChallenge();if(!game)return null;
        return Object.freeze({id:game.id,content:game.content,isCurrent:()=>!disposed&&active===run&&!run.cancelled&&run.phase==='published'&&run.revision===inventory.project_revision&&run.shell===shell&&run.session===session&&inspector?.selectedProject===inventory&&game.isCurrent()});
      },
      captureSessionNotes:(inventory)=>{
        const run=active,shell=run?.shell,session=run?.session;
        if(disposed||!run||run.cancelled||run.phase!=='published'||run.revision!==inventory.project_revision||!shell||!session)return null;
        const notes=shell.captureAttemptNotes();if(!notes)return null;
        return Object.freeze({content:notes.content,isCurrent:()=>!disposed&&active===run&&!run.cancelled&&run.phase==='published'&&run.revision===inventory.project_revision&&run.shell===shell&&run.session===session&&inspector?.selectedProject===inventory&&notes.isCurrent()});
      },captureSessionMeasured:(inventory)=>{
        const run=active,shell=run?.shell,session=run?.session;
        if(disposed||!run||run.cancelled||run.phase!=='published'||run.revision!==inventory.project_revision||!shell||!session)return null;
        const measured=shell.captureMeasuredAttempt();if(!measured)return null;
        return Object.freeze({id:measured.id,receipt:measured.receipt,isCurrent:()=>!disposed&&active===run&&!run.cancelled&&run.phase==='published'&&run.revision===inventory.project_revision&&run.shell===shell&&run.session===session&&inspector?.selectedProject===inventory&&measured.isCurrent()});
      },captureSessionTargets:(inventory)=>{
        const run=active,session=run?.session;
        if(disposed||!run||run.cancelled||run.phase!=='published'||run.revision!==inventory.project_revision||!session)return null;
        const target=session.captureTargetRecord();if(!target)return null;
        return Object.freeze({id:target.id,encode:target.encode,isCurrent:()=>!disposed&&active===run&&!run.cancelled&&run.phase==='published'&&run.revision===inventory.project_revision&&run.session===session&&inspector?.selectedProject===inventory&&target.isCurrent()});
      },onOverview: observeOverview});
    update();
    root.appendChild(container);
  } catch (error) {
    start.removeEventListener('click',startRun); close.removeEventListener('click',closeRun);
    try {inspector?.dispose();} catch {}
    container.remove(); throw error;
  }
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    disposal = new Promise<void>((yes,no) => {resolve = yes; reject = no;});
    disposed = true;
    if (active) cancelOpening(active);
    start.removeEventListener('click',startRun); close.removeEventListener('click',closeRun);
    void Promise.resolve().then(async () => {
      let error = false;
      try {inspector?.dispose();} catch {error = true;}
      const run = active;
      if (run) {try {await clean(run);} catch {error = true;}}
      active = null;
      try {container.remove();} catch {error = true;}
      if (error || failed) throw new Error('Project cleanup failed');
    }).then(resolve,reject);
    return disposal;
  }
  function openFile(file:File):void {
    if(disposed || failed || active || !inspector || !resolveTrusted)throw Error('Project application unavailable');
    autoAttempt=inspector.selectFile(file);
  }
  async function captureFile() {
    if(disposed || failed || !inspector || !active || active.phase!=='published')throw Error('Project capture unavailable');
    return inspector.captureFile();
  }
  let replacing=false;
  async function replaceFile(file:File,isCurrent:()=>boolean=()=>true) {
    if(disposed || failed || replacing || typeof isCurrent!=='function')throw Error('Project replacement unavailable');
    replacing=true;
    try {
      const run=active;
      if(run) {
        cancelOpening(run);
        try {await clean(run)} catch {failed=true;throw Error('Project cleanup failed')}
        if(disposed || (active && active!==run))throw Error('Project changed during replacement');
        if(active===run)active=null;
        update();
      }
      if(disposed || !isCurrent())throw Error('Project replacement canceled');
      openFile(file);
    } finally {replacing=false}
  }
  function getDriveSession() {
    const run=active;
    if(disposed || failed || !run || run.cancelled || run.phase!=='published' || !run.session)return null;
    return run.session;
  }
  return Object.freeze({openFile,replaceFile,captureFile,getDriveSession,dispose});
}

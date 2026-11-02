// App-owned shortcuts use the same validated target operation as every other driver.
export function mountQuickDrive(root,getSession){
 if(!root?.ownerDocument||typeof root.querySelector!=='function'||typeof getSession!=='function')throw Error('Invalid quick drive host');
 const targetPanel=root.querySelector('[data-brf=target-panel]'),viewport=root.querySelector('[data-brf=viewport]');if(!targetPanel||!viewport||targetPanel.parentElement!==viewport.parentElement)throw Error('Target controls unavailable');
 const doc=root.ownerDocument,panel=doc.createElement('section'),status=doc.createElement('p');panel.setAttribute('data-microduck','quick-drive');panel.setAttribute('aria-label','Simple drive controls');status.setAttribute('role','status');status.textContent='Choose a drive target, then press Run.';
 const choices=[['Walk','speed',.25],['Slow down','speed',0],['Turn left','turn',.5],['Go straight','turn',0],['Turn right','turn',-.5]],buttons=[];let disposed=false,busy=false;
 const same=(a,b)=>a&&b&&a.session_id===b.session_id&&a.project_revision===b.project_revision&&a.run_epoch===b.run_epoch;
 async function send(label,field,value){
  if(disposed||busy)return;let session,id;
  try{session=getSession();if(!session||!['ready-paused','paused','running'].includes(session.state)){status.textContent='Drive controls are unavailable.';return}const target=session.targets?.find(x=>x.group_id==='all'&&x.field===field);if(!target||value<target.min||value>target.max||typeof session.setTarget!=='function')throw Error('Target unavailable');id={...session.identity};}catch{status.textContent='Drive controls are unavailable.';return}
  busy=true;for(const button of buttons)button.disabled=true;status.textContent='Sending request...';
  try{const reply=await session.setTarget({group_id:'all',field,value});if(disposed)return;if(getSession()!==session||!same(id,session.identity)){status.textContent='The session changed; request outcome unknown.';return}status.textContent=reply?.status==='accepted'?`${label} requested.`:reply?.status==='rejected'?'Drive request rejected.':'Drive request outcome unknown.';}
  catch{if(!disposed)status.textContent='Drive request outcome unknown.';}
  finally{busy=false;if(!disposed)for(const button of buttons)button.disabled=false;}
 }
 const listeners=[];for(const [label,field,value] of choices){const button=doc.createElement('button');button.type='button';button.textContent=label;const listener=()=>{void send(label,field,value)};button.addEventListener('click',listener);listeners.push([button,listener]);buttons.push(button);panel.appendChild(button)}panel.appendChild(status);const note=doc.createElement('small');note.textContent='Speed is a request to the policy; low values may barely move the duck.';panel.appendChild(note);viewport.before(panel);viewport.after(targetPanel);
 const researchPane=root.querySelector('[data-brf=research-pane]'),playButton=root.querySelector('[data-brf=play]'),researchButton=root.querySelector('[data-brf=research]');
 const advanced=['show-display','refresh-display','display-status','refresh-readings'].map(role=>root.querySelector(`[data-brf=${role}]`)).filter(Boolean);
 if(researchPane && researchPane.parentElement===viewport.parentElement)viewport.before(researchPane);
 const syncMode=()=>{if(!researchPane)return;const game=researchPane.hidden;for(const element of advanced)element.hidden=game;playButton?.setAttribute('aria-pressed',String(game));researchButton?.setAttribute('aria-pressed',String(!game));};
 playButton?.addEventListener('click',syncMode);researchButton?.addEventListener('click',syncMode);syncMode();
 return Object.freeze({dispose(){if(disposed)return;disposed=true;playButton?.removeEventListener('click',syncMode);researchButton?.removeEventListener('click',syncMode);for(const [button,listener] of listeners)button.removeEventListener('click',listener);panel.remove()}});
}

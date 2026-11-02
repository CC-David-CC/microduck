// Keep the current session until a candidate has actually published. The host
// owns the final synchronous swap; every unsuccessful candidate is disposed.
export async function stageReplacement({createCandidate,file,isCurrent,signal,commit,precommit=async()=>{},timeoutMs=60000}) {
 if(typeof createCandidate!=='function'||typeof isCurrent!=='function'||typeof commit!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('Invalid replacement request');
 if(signal?.aborted||!isCurrent())throw Error('Project replacement canceled');
 let candidate,committed=false,timer,onAbort;
 const cancel=new Promise((_,reject)=>{onAbort=()=>reject(Error('Project replacement canceled'));signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>reject(Error('Project opening timed out')),timeoutMs)});
 try {
  candidate=createCandidate(file);
  if(!candidate||!candidate.ready||typeof candidate.dispose!=='function')throw Error('Project candidate unavailable');
  await Promise.race([candidate.ready,cancel]);
  if(signal?.aborted||!isCurrent())throw Error('Project replacement canceled');
  await Promise.race([precommit(),cancel]);
  if(signal?.aborted||!isCurrent())throw Error('Project replacement canceled');
  commit(candidate);committed=true;
 } finally {
  clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
  if(candidate&&!committed)await candidate.dispose();
 }
}

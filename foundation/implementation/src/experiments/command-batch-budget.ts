import {createCommandBatchRecorder} from './command-batch-record.ts';
/** Conservative UTF-8 bound for one command sidecar before advancing a world. */
export function commandBatchBudget(authority:unknown,layout:unknown,start:number,count:number):number{
 const empty=createCommandBatchRecorder(authority,layout,start,count).snapshot();
 const fixed=new TextEncoder().encode(JSON.stringify(empty)).length;
 // Per row: field/tick/sequence punctuation and up to two finite doubles plus
 // one boolean (with separators) per input. Unknown rows are smaller.
 const bound=fixed+count*(256+60*empty.layout.inputs.length);
 if(bound>65536)throw Error('Command batch exceeds response budget');return bound;
}
/** Bound a data envelope assuming numeric and nullable leaves may change after
 * a step; callers still validate the actual message and its fixed shape. */
export function stepEnvelopeBudget(value:unknown):number{
 const text=(v:string)=>new TextEncoder().encode(JSON.stringify(v)).length;
 function size(v:any,depth:number):number{
  if(depth>64)throw Error('Envelope too deep');if(v===null||typeof v==='number')return 26;if(typeof v==='boolean')return 5;if(typeof v==='string')return text(v);
  if(!v||typeof v!=='object')throw Error('Invalid envelope');
  if(Array.isArray(v))return 2+Math.max(0,v.length-1)+v.reduce((n,x)=>n+size(x,depth+1),0);
  const keys=Object.keys(v);return 2+Math.max(0,keys.length-1)+keys.reduce((n,k)=>n+text(k)+1+size(v[k],depth+1),0);
 }
 return size(value,0);
}

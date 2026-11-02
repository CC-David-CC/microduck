/** Compare two normalized world-space body orientations; q and -q are equivalent. */
export function bodyTurnRadians(a:unknown,b:unknown):number {
  const norm=(v:unknown)=>{if(!Array.isArray(v)||v.length!==4||!v.every(x=>typeof x==='number'&&Number.isFinite(x)))throw Error('Invalid orientation');const n=Math.hypot(...v);if(!Number.isFinite(n)||n<0.5||n>1.5)throw Error('Invalid orientation norm');return v.map(x=>x/n);};
  const x=norm(a),y=norm(b),dot=Math.min(1,Math.abs(x.reduce((v,n,i)=>v+n*y[i],0)));
  return 2*Math.acos(dot);
}

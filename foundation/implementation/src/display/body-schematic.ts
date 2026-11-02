/** Draw a presentation-only body hierarchy from an already validated paused frame. */
export function drawBodySchematic(canvas:HTMLCanvasElement,model:any,frame:any):number {
 if(!Array.isArray(model?.bodies)||!Array.isArray(frame?.bodies)||model.bodies.length!==frame.bodies.length||model.bodies.length<1||model.bodies.length>4096)throw Error('Invalid schematic frame');
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('Schematic unavailable');
 canvas.width=740;canvas.height=410;const w=canvas.width,h=canvas.height;
 ctx.fillStyle='#172e3b';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#31505a';ctx.lineWidth=1;
 const project=(p:number[])=>[w/2+(p[0]-p[1])*255, h*.62+(p[0]+p[1])*92-p[2]*240];
 for(let i=-4;i<=4;i++){let a=project([i*.25,-1,0]),b=project([i*.25,1,0]);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();a=project([-1,i*.25,0]);b=project([1,i*.25,0]);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();}
 let edges=0;ctx.strokeStyle='#8ce1d4';ctx.lineWidth=9;ctx.lineCap='round';
 for(let i=1;i<model.bodies.length;i++){
  const body=model.bodies[i],pose=frame.bodies[i],parent=body?.parent_id;
  if(body?.id!==i||pose?.id!==i||!Number.isSafeInteger(parent)||parent<0||parent>=i||!Array.isArray(pose.position)||pose.position.length!==3||!pose.position.every(Number.isFinite))throw Error('Invalid schematic body');
  if(parent===0)continue;const p=frame.bodies[parent]?.position;if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))throw Error('Invalid schematic parent');
  const a=project(p),b=project(pose.position);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();edges++;
 }
 // A short local-axis marker makes body orientation visible without affecting the world.
 ctx.strokeStyle='#f8dc84';ctx.lineWidth=3;ctx.lineCap='round';
 for(let i=1;i<frame.bodies.length;i++){
  const pose=frame.bodies[i],q=pose?.quaternion;if(q===undefined)continue;
  if(!Array.isArray(q)||q.length!==4||!q.every((v:any)=>typeof v==='number'&&Number.isFinite(v)))throw Error('Invalid schematic orientation');
  const n=Math.hypot(...q);if(!Number.isFinite(n)||n<0.5||n>1.5)throw Error('Invalid schematic orientation');
  const [w,x,y,z]=q.map((v:number)=>v/n),p=pose.position,axis=[1-2*(y*y+z*z),2*(x*y+w*z),2*(x*z-w*y)],tip=p.map((v:number,j:number)=>v+0.18*axis[j]);
  const a=project(p),b=project(tip);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();
 }
 ctx.fillStyle='#f7bd69';for(let i=1;i<frame.bodies.length;i++){const pos=frame.bodies[i].position;if(!Array.isArray(pos)||pos.length!==3||!pos.every(Number.isFinite))throw Error('Invalid schematic position');const [x,y]=project(pos);ctx.beginPath();ctx.arc(x,y,6,0,2*Math.PI);ctx.fill();}
 ctx.fillStyle='#eaf7fc';ctx.font='600 16px system-ui';ctx.fillText('BODY SCHEMATIC',20,28);ctx.font='14px system-ui';ctx.fillText(`Step ${frame.tick}`,20,50);return edges;
}

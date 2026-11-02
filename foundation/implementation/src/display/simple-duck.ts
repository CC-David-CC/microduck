/** Project-selected decorative view. It reads poses only; it owns no simulation state. */
export function createSimpleDuckView(canvas:HTMLCanvasElement){
 let origin:[number,number]|null=null;
 const required=['trunk_base','jaw_soft','upper_leg_left','leg','ankle_left','upper_leg_right','leg_2','ankle_right'];
 return Object.freeze({draw(model:any,frame:any){
  if(!Array.isArray(model?.bodies)||!Array.isArray(frame?.bodies)||model.bodies.length!==frame.bodies.length||model.bodies.length>4096||!Number.isSafeInteger(frame.tick)||frame.tick<0)throw Error('Invalid duck view');
  const parts:Record<string,any>=Object.create(null);for(const name of required){const matches=model.bodies.filter((x:any)=>x?.name===name);if(matches.length!==1||!Number.isSafeInteger(matches[0].id))throw Error('Duck body missing');const p=frame.bodies[matches[0].id];if(!p||p.id!==matches[0].id||!Array.isArray(p.position)||p.position.length!==3||!p.position.every(Number.isFinite)||!Array.isArray(p.quaternion)||p.quaternion.length!==4||!p.quaternion.every(Number.isFinite)||Math.abs(Math.hypot(...p.quaternion)-1)>1e-6)throw Error('Invalid duck pose');parts[name]=p;}
  const body=parts.trunk_base;if(!origin)origin=[body.position[0],body.position[1]];const anchor=origin;
  canvas.width=740;canvas.height=410;const c=canvas.getContext('2d');if(!c)throw Error('Canvas unavailable');
  const project=(p:number[])=>[215+(p[0]-anchor[0])*850-(p[1]-anchor[1])*360,305-p[2]*850+(p[0]-anchor[0])*110+(p[1]-anchor[1])*110];
  c.fillStyle='#dff4f2';c.fillRect(0,0,740,410);c.fillStyle='#b6ddcf';c.fillRect(0,305,740,105);c.strokeStyle='#89c5b7';c.lineWidth=1;
  for(let i=-4;i<=8;i++){const x=215+i*100;c.beginPath();c.moveTo(x,305);c.lineTo(x-170,410);c.stroke()}
  const p=(name:string)=>project(parts[name].position),torso=p('trunk_base'),head=p('jaw_soft');
  c.fillStyle='rgba(44,92,81,0.20)';c.beginPath();c.ellipse(torso[0],308,58,13,0,0,Math.PI*2);c.fill();
  const leg=(hip:string,knee:string,foot:string,color:string)=>{const a=p(hip),b=p(knee),d=p(foot);c.strokeStyle=color;c.lineWidth=10;c.lineCap='round';c.lineJoin='round';c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.lineTo(d[0],d[1]);c.stroke();c.fillStyle='#ef9a39';c.beginPath();c.ellipse(d[0]+8,d[1]+2,16,7,0,0,Math.PI*2);c.fill()};
  leg('upper_leg_right','leg_2','ankle_right','#d79b40');leg('upper_leg_left','leg','ankle_left','#efb84a');
  c.strokeStyle='#edc457';c.lineWidth=23;c.lineCap='round';c.beginPath();c.moveTo(torso[0]+12,torso[1]-8);c.lineTo(head[0],head[1]+12);c.stroke();
  c.fillStyle='#f5d66c';c.beginPath();c.ellipse(torso[0],torso[1],52,33,-0.12,0,Math.PI*2);c.fill();c.fillStyle='#ebbd55';c.beginPath();c.ellipse(torso[0]-12,torso[1]+4,24,13,-0.28,0,Math.PI*2);c.fill();
  c.fillStyle='#f8dd79';c.beginPath();c.arc(head[0],head[1],27,0,Math.PI*2);c.fill();
  const [w,x,y,z]=parts.trunk_base.quaternion,dir=[1-2*(y*y+z*z),2*(x*y+w*z),2*(x*z-w*y)],tip=project(parts.jaw_soft.position.map((v:number,j:number)=>v+dir[j]*0.05)),dx=tip[0]-head[0],dy=tip[1]-head[1],angle=Math.atan2(dy,dx);
  c.save();c.translate(head[0],head[1]);c.rotate(angle);c.fillStyle='#ef9840';c.beginPath();c.moveTo(22,-6);c.lineTo(44,0);c.lineTo(22,8);c.closePath();c.fill();c.fillStyle='#233b3e';c.beginPath();c.arc(8,-10,3.5,0,Math.PI*2);c.fill();c.restore();
  c.fillStyle='#22484a';c.font='600 16px system-ui';c.fillText('SIMPLE DUCK VIEW',20,28);c.font='14px system-ui';c.fillText(`Step ${frame.tick}`,20,49);
 }});
}


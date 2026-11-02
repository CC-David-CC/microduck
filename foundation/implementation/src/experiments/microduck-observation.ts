/** Compose the pinned Microduck walking policy's inputs; this grants no observation authority. */
export function composeMicroduckObservation(input:unknown):Float32Array {
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('Invalid Microduck observation');
 const shape=[['gyro',3],['quaternion',4],['jointPosition',14],['jointVelocity',14],['previousAction',14],['command',13]] as const;
 const keys=Reflect.ownKeys(input);if(keys.length!==shape.length||keys.some(k=>typeof k!=='string'||!shape.some(([name])=>name===k)))throw Error('Invalid Microduck observation');
 const arrays:Record<string,number[]>=Object.create(null);
 for(const [name,length] of shape){
  const field=Object.getOwnPropertyDescriptor(input,name);if(!field||!Object.hasOwn(field,'value')||!Array.isArray(field.value)||Object.getPrototypeOf(field.value)!==Array.prototype||field.value.length!==length||Reflect.ownKeys(field.value).length!==length+1)throw Error('Invalid Microduck observation');
  const copy:number[]=[];for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(field.value,String(i));if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='number'||!Number.isFinite(d.value))throw Error('Invalid Microduck observation');copy.push(d.value)}arrays[name]=copy;
 }
 const [w,x,y,z]=arrays.quaternion,norm=w*w+x*x+y*y+z*z;if(!Number.isFinite(norm)||Math.abs(norm-1)>1e-6)throw Error('Invalid Microduck orientation');
 const defaults=new Float32Array([0,-0.08726646259971647,-0.457924,-0.004940,0.452984,0.3490658503988659,0.3490658503988659,0,0,0,0.08726646259971647,0.457924,0.004940,-0.452984]);
 const result=new Float32Array(61);result.set(arrays.gyro,0);result[3]=2*(w*y-x*z);result[4]=-2*(y*z+w*x);result[5]=-1+2*(x*x+y*y);
 for(let i=0;i<14;i++){result[6+i]=arrays.jointPosition[i]-defaults[i];result[20+i]=arrays.jointVelocity[i];result[34+i]=arrays.previousAction[i]}
 result.set(arrays.command,48);if(!result.every(Number.isFinite))throw Error('Microduck observation overflow');return result;
}

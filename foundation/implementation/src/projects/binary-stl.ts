export type BinaryStlLimits=Readonly<{maxBytes:number;maxTriangles:number;maxAbsCoordinate:number}>;
export class BinaryStlError extends Error {readonly code:'invalid'|'limit';constructor(code:'invalid'|'limit',message:string){super(message);this.code=code;this.name='BinaryStlError';}}
/** Validate a bounded, uncolored binary STL without changing or allocating geometry. */
export function inspectBinaryStl(bytes:unknown,limits:unknown){
 if(!(bytes instanceof Uint8Array)||!limits||typeof limits!=='object'||Array.isArray(limits))throw Error('Invalid STL input');
 const read=(key:string)=>{const d=Object.getOwnPropertyDescriptor(limits,key);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='number'||!Number.isFinite(d.value))throw Error('Invalid STL limit');return d.value as number;};
 const maxBytes=read('maxBytes'),maxTriangles=read('maxTriangles'),maxAbsCoordinate=read('maxAbsCoordinate');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxTriangles)||maxTriangles<1||maxAbsCoordinate<=0)throw Error('Invalid STL limit');
 if(bytes.byteLength<84)throw new BinaryStlError('invalid','Invalid STL byte length');
 if(bytes.byteLength>maxBytes)throw new BinaryStlError('limit','STL byte limit exceeded');
 const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),triangles=data.getUint32(80,true);
 if(triangles<1||triangles>(bytes.byteLength-84)/50||84+triangles*50!==bytes.byteLength)throw new BinaryStlError('invalid','Invalid STL triangle count');
 if(triangles>maxTriangles)throw new BinaryStlError('limit','STL triangle limit exceeded');
 const minimum=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<triangles;i++){
  const offset=84+i*50;
  for(let j=0;j<12;j++){
   const n=data.getFloat32(offset+j*4,true);if(!Number.isFinite(n))throw new BinaryStlError('invalid','Nonfinite STL coordinate');
   if(j>=3){if(Math.abs(n)>maxAbsCoordinate)throw new BinaryStlError('limit','STL coordinate exceeds limit');const axis=(j-3)%3;minimum[axis]=Math.min(minimum[axis],n);maximum[axis]=Math.max(maximum[axis],n);}
  }
  if(data.getUint16(offset+48,true)!==0)throw new BinaryStlError('invalid','STL facet attributes unsupported');
 }
 return Object.freeze({triangles,minimum:Object.freeze(minimum),maximum:Object.freeze(maximum)});
}

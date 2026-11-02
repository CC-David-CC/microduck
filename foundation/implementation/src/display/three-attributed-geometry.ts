import * as THREE from 'three/webgpu';
import {joinMeshAttributes} from './mesh-attribute-join.ts';

/** Expand independent compiled corner indices into reusable Three geometries. */
export function createAttributedGeometries(input:unknown) {
  const joined=joinMeshAttributes(input);
  let bytes=0;
  for(const mesh of joined.meshes) {
    if(mesh.indices.length && !mesh.normal.present)throw Error('Mesh normals unavailable');
    bytes+=mesh.indices.length*(24+(mesh.uv.present?8:0));
    if(!Number.isSafeInteger(bytes) || bytes>20*1024*1024)throw Error('Expanded geometry capacity exceeded');
  }
  const geometries:Array<{id:number;geometry:any}>=[];
  const disposeAll=()=>{
    const failures:unknown[]=[];
    for(const entry of geometries)try{entry.geometry.dispose();}catch(error){failures.push(error);}
    return failures;
  };
  try {
    for(const mesh of joined.meshes) {
      const corners=mesh.indices.length,positions=new Float32Array(corners*3),normals=new Float32Array(corners*3),
        uvs=mesh.uv.present?new Float32Array(corners*2):null;
      for(let i=0;i<corners;i++) {
        const p=mesh.indices[i]*3,n=mesh.normal.face_indices[i]*3;
        for(let j=0;j<3;j++){positions[i*3+j]=mesh.positions[p+j];normals[i*3+j]=mesh.normal.values[n+j];}
        if(uvs){const u=mesh.uv.face_indices[i]*2;uvs[i*2]=mesh.uv.values[u];uvs[i*2+1]=mesh.uv.values[u+1];}
      }
      const geometry=new THREE.BufferGeometry();geometries.push({id:mesh.id,geometry});
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));
      if(uvs)geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
    }
  } catch(error) {
    const failures=disposeAll();
    if(failures.length)throw new AggregateError([error,...failures],'Geometry conversion cleanup failed');
    throw error;
  }
  let disposed=false;
  return {geometries,dispose(){
    if(disposed)return;disposed=true;
    const failures=disposeAll();if(failures.length)throw new AggregateError(failures,'Geometry disposal failed');
  }};
}

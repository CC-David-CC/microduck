import {createMicroduckPlantSource} from './microduck-plant-source.ts';
import {createMicroduckTruthChannel} from './microduck-truth-channel.ts';
export async function createWorldMicroduckTruth(identity:any,plant:any,config:any){
 if(!config||typeof config!=='object'||Reflect.ownKeys(config).length!==4||!['sensor_name','body_name','joint_names','channel_id'].every(k=>Object.hasOwn(config,k)))throw Error('Invalid truth configuration');
 const source=createMicroduckPlantSource(plant,{sensor_name:config.sensor_name,body_name:config.body_name,joint_names:config.joint_names});
 let channel;try{channel=await createMicroduckTruthChannel(identity,source,config.channel_id)}catch(e){source.close();throw e}
 let prepared:any=null;
 return {describe(){return {channel:channel.describe()}},advanceBoundary(id:any){prepared=channel.read(id)},read(){if(!prepared)throw Error('Truth not prepared');return structuredClone(prepared)},reset(id:any){channel.reset(id);prepared=null},close(){channel.close();prepared=null}};
}

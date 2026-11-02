import {readFile} from 'node:fs/promises';import {createInterface} from 'node:readline';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const root=process.env.MICRODUCK_REFERENCE_INPUTS;if(!root || !process.env.MICRODUCK_REFERENCE_ORT)throw Error('Reference inputs and ONNX runtime path required');
const referenceOrt=pathToFileURL(process.env.MICRODUCK_REFERENCE_ORT);const ortPackage=JSON.parse(await readFile(new URL('../package.json',referenceOrt)));if(ortPackage.version!=='1.27.0')throw Error('Reference requires onnxruntime-web 1.27.0');
const ort=await import(referenceOrt);ort.env.wasm.numThreads=1;
const bytes=await readFile(root+'/policy/alpha_walking.onnx');if(createHash('sha256').update(bytes).digest('hex')!=='e36332d383997d51401897734cd3e79cf5038406feddb18b4d57ecfb141daa6c')throw Error('Wrong policy');
const session=await ort.InferenceSession.create(new Uint8Array(bytes),{executionProviders:['wasm']});
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 const obs=JSON.parse(line);if(!Array.isArray(obs)||obs.length!==61||!obs.every(Number.isFinite))throw Error('Invalid observation');
 const result=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',Float32Array.from(obs),[1,61])});const action=Array.from(result[session.outputNames[0]].data);
 if(action.length!==14||!action.every(Number.isFinite))throw Error('Invalid action');process.stdout.write(JSON.stringify(action)+'\n');
}
await session.release();

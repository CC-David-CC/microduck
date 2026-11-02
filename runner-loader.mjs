import {createMicroduckPolicy} from './policy.mjs';
import {createMicroduckController} from './controller.mjs';

// This inert source is an explicit declaration, never evaluated. The dedicated
// Microduck runner accepts these exact bytes and no other controller source.
export const MICRODUCK_SOURCE_PATH = 'controllers/microduck-policy.mjs';
export const MICRODUCK_SOURCE = [
 "// Built-in Microduck alpha walking policy adapter v1.",
 "// Requires the dedicated Microduck runner; never execute this declaration.",
 "export function initialize() { throw new Error('Microduck adapter runner required'); }",
 "export function step() { throw new Error('Microduck adapter runner required'); }",
 "export function dispose() { throw new Error('Microduck adapter runner required'); }",
 ""
].join('\n');
const MODEL_HASH='e36332d383997d51401897734cd3e79cf5038406feddb18b4d57ecfb141daa6c';
const WASM_HASH='4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d';
const MAX_MODEL=8*1024*1024, MAX_WASM=24*1024*1024;
async function sha(bytes) {
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
}

// One dedicated worker owns one loader and its copied model/runtime assets.
// The caller has already supplied revision-bound grant/lease authority.
export function createMicroduckRunnerLoader({runtime,modelBytes,wasmBytes}) {
 if (!runtime?.env?.wasm || !(modelBytes instanceof Uint8Array) || !modelBytes.byteLength ||
     modelBytes.byteLength>MAX_MODEL || !(wasmBytes instanceof Uint8Array) || !wasmBytes.byteLength ||
     wasmBytes.byteLength>MAX_WASM) throw new Error('Invalid Microduck runner assets');
 const model=Uint8Array.from(modelBytes), wasm=Uint8Array.from(wasmBytes);
 let consumed=false;
 return async function load(source,sourceId,descriptor) {
  if (consumed) throw new Error('Microduck runner already consumed');
  consumed=true;
  if (source!==MICRODUCK_SOURCE || sourceId!==MICRODUCK_SOURCE_PATH || descriptor?.control_size!==14)
   throw new Error('Unsupported Microduck controller declaration');
  const [modelHash,wasmHash]=await Promise.all([sha(model),sha(wasm)]);
  if (modelHash!==MODEL_HASH || wasmHash!==WASM_HASH) throw new Error('Microduck runner asset hash mismatch');
  runtime.env.wasm.numThreads=1;
  runtime.env.wasm.wasmBinary=wasm;
  const policy=await createMicroduckPolicy({runtime,modelBytes:model,expectedSha256:MODEL_HASH});
  return createMicroduckController(policy);
 };
}

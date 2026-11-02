import type {Controller} from '../../../contracts/runtime.ts';
import {prepareJsModule, type JsModuleSourceResult} from './js-module-source.ts';

type Failure = Extract<JsModuleSourceResult, {ok: false}>;
export type NativeJsAdmissionFailure = Failure;
export type NativeJsLoadResult =
  | {readonly ok: true; readonly controller: Controller<unknown>}
  | {readonly ok: false; readonly code: 'ALREADY_CONSUMED' | 'EVALUATION'}
  | {readonly ok: false; readonly code: 'ADMISSION'; readonly admission: Failure};

export function createOneShotNativeJsLoader():
  (source: string, sourceId: string) => Promise<NativeJsLoadResult> {
  const apply = Reflect.apply;
  const create = Object.create;
  const freeze = Object.freeze;
  const NativeBlob = Blob;
  const NativeURL = URL;
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const failure = (code: 'ALREADY_CONSUMED' | 'EVALUATION'): NativeJsLoadResult => {
    const result = create(null) as {ok: false; code: 'ALREADY_CONSUMED' | 'EVALUATION'};
    result.ok = false;
    result.code = code;
    return freeze(result);
  };
  let consumed = false;
  return async (source, sourceId) => {
    if (consumed) return failure('ALREADY_CONSUMED');
    consumed = true;
    let admission: JsModuleSourceResult;
    try { admission = prepareJsModule(source, sourceId); }
    catch { return failure('EVALUATION'); }
    if (!admission.ok) {
      const result = create(null) as {ok: false; code: 'ADMISSION'; admission: Failure};
      result.ok = false;
      result.code = 'ADMISSION';
      result.admission = admission;
      return freeze(result);
    }
    let url: string | undefined;
    let namespace: Record<string, unknown> | undefined;
    let failed = false;
    try {
      const blob = new NativeBlob([source], {type: 'text/javascript', endings: 'transparent'});
      url = apply(createUrl, NativeURL, [blob]) as string;
      namespace = await import(/* @vite-ignore */ url) as Record<string, unknown>;
    } catch { failed = true; }
    finally {
      if (url !== undefined) {
        try { apply(revokeUrl, NativeURL, [url]); }
        catch { failed = true; }
      }
    }
    if (failed || !namespace) return failure('EVALUATION');
    const controller = create(null) as Controller<unknown>;
    const bind = (name: 'initialize' | 'step' | 'dispose') => function (...args: unknown[]) {
      const operation = namespace![name];
      if (typeof operation !== 'function') throw 'ABI_BINDING_NOT_CALLABLE';
      return apply(operation, undefined, args);
    };
    const bindings = controller as unknown as Record<string, unknown>;
    bindings.initialize = bind('initialize');
    bindings.step = bind('step');
    bindings.dispose = bind('dispose');
    const result = create(null) as {ok: true; controller: Controller<unknown>};
    result.ok = true;
    result.controller = freeze(controller);
    return freeze(result);
  };
}

import {parse, getLineInfo, version} from 'acorn';
import {admitJsModule, type JsAdmissionResult} from './js-admission.ts';

type Admitted = Extract<JsAdmissionResult, {ok: true}>;
type Rejected = Extract<JsAdmissionResult, {ok: false}>;
export type JsModuleSourceResult =
  | ({ok: true} & Pick<Admitted, 'sourceId' | 'source' | 'bindings' | 'parser'>)
  | Rejected
  | {ok: false; sourceId: string; source: string; diagnostic: {
      code: 'DEBUG_DIRECTIVE'; message: string; start: number; end: number; line: number; column: number;
    }};

/** Preserve native module source as inert text. This is only one prerequisite
 * for the separately qualified worker loader, not an execution boundary. */
export function prepareJsModule(source: string, sourceId: string): JsModuleSourceResult {
  const admitted = admitJsModule(source, sourceId);
  if (!admitted.ok) return admitted;
  try {
    if (version !== '8.19.0') throw new Error('Unqualified parser version');
    const reserved: {first?: {start: number; end: number}} = {};
    parse(source, {ecmaVersion: 2022, sourceType: 'module', locations: true, ranges: true,
      onComment(_block, text, start, end) {
        if ((!reserved.first || start < reserved.first.start) &&
            /^\s*[@#]\s*(?:sourceURL|sourceMappingURL)\s*=/u.test(text)) {
          reserved.first = {start, end};
        }
      },
    });
    if (reserved.first) {
      return {ok: false, sourceId, source, diagnostic: {code: 'DEBUG_DIRECTIVE',
        message: 'Debugger sourceURL/sourceMappingURL directives are unsupported; original source is unchanged.',
        ...reserved.first, ...getLineInfo(source, reserved.first.start)}};
    }
    return {ok: true, sourceId, source, bindings: admitted.bindings, parser: admitted.parser};
  } catch {
    return {ok: false, sourceId, source, diagnostic: {code: 'PARSE_FAILURE',
      message: 'Native module comment analysis could not complete.',
      start: 0, end: source.length, line: 1, column: 0}};
  }
}

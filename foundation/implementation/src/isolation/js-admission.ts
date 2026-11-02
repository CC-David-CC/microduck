import {parse, getLineInfo, version, type AnyNode, type Node, type Token} from 'acorn';

export type AbiName = 'initialize' | 'step' | 'dispose';
export type DiagnosticCode = 'SOURCE_ENCODING' | 'SOURCE_LIMIT' | 'SYNTAX' | 'PARSE_FAILURE' |
  'IMPORT_UNSUPPORTED' | 'IMPORT_META_UNSUPPORTED' | 'EXPORT_FORM_UNSUPPORTED' |
  'ABI_EXPORTS' | 'ABI_FUNCTION' | 'TOP_LEVEL_AWAIT' | 'DIRECT_EVAL' | 'MODULE_ARGUMENTS';
export type JsAdmissionResult = {
  ok: true; sourceId: string; source: string; body: string;
  bindings: Record<AbiName, {local: string; async: boolean}>;
  edits: Array<{start: number; end: number; kind: 'export-keyword' | 'export-list'}>;
  parser: {name: 'acorn'; version: '8.19.0'; ecmaVersion: 2022};
} | {
  ok: false; sourceId: string; source: string;
  diagnostic: {code: DiagnosticCode; message: string; start: number; end: number; line: number; column: number};
};

type Failure = Extract<JsAdmissionResult, {ok: false}>;
const abiNames: readonly AbiName[] = ['initialize', 'step', 'dispose'];
const isNode = (value: unknown): value is AnyNode => value !== null && typeof value === 'object' &&
  'type' in value && typeof value.type === 'string' && 'start' in value && 'end' in value;

function isReference(parent: AnyNode | undefined, key: string): boolean {
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
  if ((parent.type === 'Property' || parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition') &&
      key === 'key' && !parent.computed) return false;
  if ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') &&
      key === 'label') return false;
  return parent.type !== 'ExportSpecifier' && parent.type !== 'MetaProperty';
}

/** Text admission only: no controller code is loaded or executed here. The loader
 * retains the source bytes; a separately qualified worker must enforce confinement. */
export function admitJsModule(source: string, sourceId: string): JsAdmissionResult {
  const fail = (code: DiagnosticCode, message: string, start = 0, end = source.length): Failure => ({
    ok: false, sourceId, source, diagnostic: {code, message: message.slice(0, 1000), start, end,
      ...(start === 0 ? {line: 1, column: 0} : getLineInfo(source, start))},
  });
  try {
    let offset = 0;
    for (const character of source) {
      const point = character.codePointAt(0)!;
      if (point >= 0xd800 && point <= 0xdfff) return fail('SOURCE_ENCODING', 'Unpaired UTF-16 source character', offset, offset + 1);
      offset += character.length;
    }
    // Valid UTF-8 needs at least as many bytes as UTF-16 code units. Reject an
    // already oversized string without allocating another oversized byte buffer.
    if (source.length > 131072 || new TextEncoder().encode(source).byteLength > 131072) {
      return fail('SOURCE_LIMIT', 'Source exceeds 131072 UTF-8 bytes');
    }
    if (version !== '8.19.0') throw new Error('Unqualified parser version');
    const tokens: Token[] = [];
    let program: ReturnType<typeof parse>;
    try {
      program = parse(source, {ecmaVersion: 2022, sourceType: 'module', locations: true, ranges: true, onToken: tokens});
    } catch (error) {
      if (error instanceof SyntaxError && !error.message.startsWith('Not enough stack space to parse input')) {
        const position = 'pos' in error && typeof error.pos === 'number' ? error.pos : 0;
        return fail('SYNTAX', error.message, position, Math.min(source.length, position + 1));
      }
      throw error;
    }
    const faults: {first?: {node: Node; code: DiagnosticCode; message: string}} = {};
    const flag = (node: Node, code: DiagnosticCode, message: string) => {
      const first = faults.first?.node;
      if (!first || node.start < first.start || (node.start === first.start && node.end > first.end)) {
        faults.first = {node, code, message};
      }
    };
    function visit(node: AnyNode, functionDepth: number, ownsArguments: boolean, parent?: AnyNode, key = ''): void {
      const ordinaryFunction = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression';
      const childDepth = functionDepth + (ordinaryFunction || node.type === 'ArrowFunctionExpression' ? 1 : 0);
      const childArguments = ownsArguments || ordinaryFunction;
      if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') {
        flag(node, 'IMPORT_UNSUPPORTED', 'Controller dependencies must be explicitly bundled before admission');
      } else if (node.type === 'MetaProperty' && node.meta.name === 'import') {
        flag(node, 'IMPORT_META_UNSUPPORTED', 'import.meta is outside the admitted self-contained subset');
      } else if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportAllDeclaration' ||
          (node.type === 'ExportNamedDeclaration' && (node.source ||
            (node.declaration && node.declaration.type !== 'FunctionDeclaration') ||
            node.specifiers.some(specifier => specifier.exported.type !== 'Identifier' || specifier.local.type !== 'Identifier')))) {
        flag(node, 'EXPORT_FORM_UNSUPPORTED', 'Use named function declarations or identifier export lists');
      } else if ((node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) && functionDepth === 0) {
        flag(node, 'TOP_LEVEL_AWAIT', 'Module-level await cannot be preserved by this admission');
      } else if (node.type === 'CallExpression' && !node.optional && node.callee.type === 'Identifier' && node.callee.name === 'eval') {
        flag(node, 'DIRECT_EVAL', 'Direct eval can observe the later factory scope');
      } else if (node.type === 'Identifier' && node.name === 'arguments' && !ownsArguments && isReference(parent, key)) {
        flag(node, 'MODULE_ARGUMENTS', 'Module-scope arguments or its arrow capture is unsupported');
      }
      for (const [field, value] of Object.entries(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
          if (isNode(child)) visit(child, childDepth, childArguments, node, field);
        }
      }
    }
    visit(program, 0, false);
    if (faults.first) {
      const {node, code, message} = faults.first;
      return fail(code, message, node.start, node.end);
    }
    const declarations = new Map<string, AnyNode>();
    function register(pattern: AnyNode, declaration: AnyNode): void {
      if (pattern.type === 'Identifier') { declarations.set(pattern.name, declaration); return; }
      const children = pattern.type === 'ObjectPattern' ? pattern.properties.map(property =>
        property.type === 'Property' ? property.value : property.argument) :
        pattern.type === 'ArrayPattern' ? pattern.elements : pattern.type === 'AssignmentPattern' ? [pattern.left] :
        pattern.type === 'RestElement' ? [pattern.argument] : [];
      for (const child of children) if (child) register(child, declaration);
    }
    const exported = new Map<string, string>();
    const edits: Extract<JsAdmissionResult, {ok: true}>['edits'] = [];
    for (const statement of program.body) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
        if (declaration.id) declarations.set(declaration.id.name, declaration);
      } else if (declaration?.type === 'VariableDeclaration') {
        for (const variable of declaration.declarations) register(variable.id, declaration);
      }
      if (statement.type !== 'ExportNamedDeclaration') continue;
      if (statement.declaration?.type === 'FunctionDeclaration') {
        const local = statement.declaration.id.name;
        exported.set(local, local);
        const token = tokens.find(candidate => candidate.start === statement.start && candidate.type.label === 'export');
        if (!token) throw new Error('Missing export token');
        edits.push({start: token.start, end: token.end, kind: 'export-keyword'});
      } else {
        for (const specifier of statement.specifiers) {
          if (specifier.exported.type !== 'Identifier' || specifier.local.type !== 'Identifier') throw new Error('Unsupported export reached transformation');
          exported.set(specifier.exported.name, specifier.local.name);
        }
        edits.push({start: statement.start, end: statement.end, kind: 'export-list'});
      }
    }
    if (exported.size !== 3 || abiNames.some(name => !exported.has(name))) {
      return fail('ABI_EXPORTS', 'Export exactly initialize, step and dispose');
    }
    const bindings = {} as Record<AbiName, {local: string; async: boolean}>;
    for (const name of abiNames) {
      const local = exported.get(name)!;
      const declaration = declarations.get(local);
      if (declaration?.type !== 'FunctionDeclaration' || declaration.generator || (name !== 'step' && declaration.async)) {
        return fail('ABI_FUNCTION', 'ABI exports must bind top-level nongenerator functions; only step may be async',
          declaration?.start ?? 0, declaration?.end ?? source.length);
      }
      bindings[name] = {local, async: declaration.async};
    }
    const units = source.split(''); // UTF-16 units, including both halves of masked pairs.
    edits.sort((a, b) => a.start - b.start);
    for (const edit of edits) {
      for (let index = edit.start; index < edit.end; index++) {
        if (!'\r\n\u2028\u2029'.includes(units[index])) units[index] = ' ';
      }
      if (edit.kind === 'export-list') units[edit.start] = ';'; // Preserve ASI statement boundaries.
    }
    return {ok: true, sourceId, source, body: units.join(''), bindings, edits,
      parser: {name: 'acorn', version: '8.19.0', ecmaVersion: 2022}};
  } catch {
    return fail('PARSE_FAILURE', 'Source analysis could not complete within the supported parser capability');
  }
}


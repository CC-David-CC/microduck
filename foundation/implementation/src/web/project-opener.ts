import {isCapturedProjectInventory} from '../projects/project-inventory.ts';
import {createBrowserSession} from '../session/browser-session.ts';
import {copyBounded} from '../session/project-world-wire.ts';
import {readSourceMaterialFailure} from '../session/project-world-manager.ts';

const readBlob = Blob.prototype.arrayBuffer;
// Host contract: asynchronous resolver results must be ordinary native Promises,
// with unmodified constructor/species behavior. The host owns unsupported
// Promise behavior; this probe is not a validator for that obligation.
const nativeThen = Promise.prototype.then;
const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
type Session = Awaited<ReturnType<typeof createBrowserSession>>;

function exact(value: any, names: string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && names.every(k => {
    const d = Object.getOwnPropertyDescriptor(value, k);
    return !!d && Object.hasOwn(d, 'value') && d.enumerable;
  });
}

export function createProjectOpener(options: {
  getSelected: () => unknown;
  resolveTrusted: (revision: string) => unknown | Promise<unknown>;
  mount: HTMLElement;
}) {
  if (!options || typeof options.getSelected !== 'function' || typeof options.resolveTrusted !== 'function' || !options.mount) {
    throw new Error('Invalid project opener configuration');
  }
  const {getSelected, resolveTrusted, mount} = options;
  let owned: Session | null = null, pending: Promise<void> | null = null;
  let disposed = false, disposal: Promise<void> | null = null, cleanupFailed = false;

  async function clean(session: Session) {
    try { await session.dispose(); }
    catch { cleanupFailed = true; throw new Error('Project session cleanup failed'); }
  }

  function open(): Promise<Session> {
    if (disposed || pending || owned || cleanupFailed) return Promise.reject(new Error('Project opener unavailable'));
    let finish!: () => void;
    pending = new Promise<void>(resolve => { finish = resolve; });
    let selected: unknown;
    try { selected = getSelected(); }
    catch { pending = null; finish(); return Promise.reject(new Error('Project selection unavailable')); }
    const run = async (): Promise<Session> => {
      let session: Session | null = null;
      let failureMessage = 'Project open failed';
      let revision: string | null = null;
      try {
        if (disposed || !isCapturedProjectInventory(selected)) throw new Error('Invalid selection');
        const inventory = selected;
        const current = () => {
          if (disposed || getSelected() !== inventory || disposed) throw new Error('Selection changed');
        };
        revision = inventory.project_revision;
        let response: unknown;
        try { response = resolveTrusted(revision); }
        catch { failureMessage = 'Trusted host decision unavailable'; throw new Error(failureMessage); }
        let settle!: (v: unknown) => void, reject!: () => void;
        const promised = new Promise<unknown>((yes, no) => { settle = yes; reject = () => no(new Error('Trusted host decision unavailable')); });
        let isPromise = false;
        try {
          Reflect.apply(nativeThen, response, [
            (value: unknown) => { try { settle(copyBounded(value, 1048576)); } catch { reject(); } },
            () => { reject(); }
          ]);
          isPromise = true;
        } catch { /* Not a native Promise, or a hostile Promise boundary. */ }
        let decision: any;
        if (isPromise) {
          try { decision = await promised; }
          catch { failureMessage = 'Trusted host decision unavailable'; throw new Error(failureMessage); }
        } else {
          decision = copyBounded(response, 1048576);
        }
        current();
        if (!exact(decision, ['project_revision','profile','controllers','runnerOrigin','frameURL','policy']) ||
            decision.project_revision !== revision || typeof decision.runnerOrigin !== 'string' ||
            !decision.runnerOrigin || typeof decision.frameURL !== 'string' || !decision.frameURL) throw new Error('Decision denied');
        const policy = decision.policy;
        const policyKeys = ['inventoryLimits','compileLimits','timeoutMs','maxReplyBytes','frameTimeoutMs','approvedGrants'];
        if (Object.hasOwn(policy ?? {}, 'wasmUrl')) policyKeys.push('wasmUrl');
        if (Object.hasOwn(policy ?? {}, 'approvedRecordingGrants')) policyKeys.push('approvedRecordingGrants');
        if (!exact(policy, policyKeys) || !Number.isSafeInteger(policy.maxReplyBytes) || policy.maxReplyBytes < 1 ||
            !Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 1 ||
            !Number.isSafeInteger(policy.frameTimeoutMs) || policy.frameTimeoutMs < 1 || policy.frameTimeoutMs > 60000 ||
            (Object.hasOwn(policy, 'wasmUrl') && typeof policy.wasmUrl !== 'string')) throw new Error('Invalid policy');
        copyBounded(decision.profile, policy.maxReplyBytes);
        copyBounded(decision.controllers, policy.maxReplyBytes);
        copyBounded(policy, policy.maxReplyBytes);
        const limits = policy.inventoryLimits;
        const limitNames = ['max_files','max_total_bytes','max_file_bytes','max_manifest_bytes','max_manifest_depth'];
        if (!exact(limits, limitNames) || limitNames.some(k => !Number.isSafeInteger(limits[k]) || limits[k] < 1) ||
            limits.max_manifest_depth > 64) throw new Error('Invalid inventory limits');
        const files = Object.values(inventory.files);
        if (files.length > limits.max_files || inventory.total_bytes > limits.max_total_bytes) throw new Error('Inventory exceeds limits');
        let total = 0;
        for (const file of files) {
          const size = Reflect.apply(blobSize, file.content, []);
          if (!Number.isSafeInteger(size) || size !== file.bytes || size > limits.max_file_bytes ||
              (file.path === 'manifest.json' && size > limits.max_manifest_bytes) ||
              size > limits.max_total_bytes - total) throw new Error('Inventory exceeds limits');
          total += size;
        }
        if (total !== inventory.total_bytes) throw new Error('Inventory mismatch');
        current();
        const entries: {path: string; data: Uint8Array}[] = [];
        for (const file of files) {
          const buffer = await Reflect.apply(readBlob, file.content, []);
          current();
          const data = new Uint8Array(buffer);
          if (data.byteLength !== file.bytes) throw new Error('Inventory size mismatch');
          entries.push({path: file.path, data});
        }
        current();
        session = await createBrowserSession({runInput: {project_revision: revision, entries,
          profile: decision.profile, controllers: decision.controllers}, mount,
          runnerOrigin: decision.runnerOrigin, frameURL: decision.frameURL, policy});
        current();
        if (!session || session.identity?.project_revision !== revision) throw new Error('Invalid session revision');
        current();
        owned = session;
        session = null;
        return owned;
      } catch (error) {
        if (session) await clean(session);
        const facts = readSourceMaterialFailure(error);
        let current = false;
        try {current = !disposed && !cleanupFailed && !session && getSelected() === selected && !disposed;} catch {current = false;}
        if (current && facts && facts.project_revision === revision) throw error;
        throw new Error(failureMessage);
      } finally {
        pending = null;
        finish();
      }
    };
    return run();
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposed = true;
    disposal = Promise.resolve().then(async () => {
      const wait = pending;
      if (wait) await wait;
      if (owned) {
        const session = owned;
        owned = null;
        await clean(session);
      }
      if (cleanupFailed) throw new Error('Project session cleanup failed');
    });
    return disposal;
  }
  return {open, dispose, get session() { return owned; }};
}

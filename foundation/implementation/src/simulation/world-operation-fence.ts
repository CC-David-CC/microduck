/**
 * Shared trusted-host exclusion for controller boundaries and world reset/disposal.
 * The WeakMaps keep mutable lock state outside both the world model and physics.
 */
export type WorldOperationFence = object;
export type WorldOperationReservation = object;
export type WorldOperationRelease = () => void;

type FenceState = {
  active: object | null;
  reservation: WorldOperationReservation | null;
  initializing: boolean;
};

// Enumerable so an ordinary Proxy or object spread preserves the same plant
// identity. The symbol itself stays module-private; callers cannot mint a
// valid handle, and an unknown value under this brand fails closed.
const REAL_WORLD_OPERATION_FENCE = Symbol('real-world-operation-fence');
const fenceStates = new WeakMap<object, FenceState>();
const worldStates = new WeakMap<object, FenceState>();
const releasedReservations = new WeakMap<object, object>();

function object(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function stateForWorld(world: unknown): FenceState {
  if (!object(world)) throw new Error('World operation requires a world object');
  const cached = worldStates.get(world);

  let hasRealWorldBrand: boolean;
  try { hasRealWorldBrand = REAL_WORLD_OPERATION_FENCE in world; }
  catch { throw new Error('Cannot inspect world operation fence brand'); }
  if (hasRealWorldBrand) {
    let handle: unknown;
    try { handle = Reflect.get(world, REAL_WORLD_OPERATION_FENCE); }
    catch { throw new Error('Cannot read world operation fence brand'); }
    const state = object(handle) ? fenceStates.get(handle) : undefined;
    if (!state) throw new Error('Unknown world operation fence brand');
    if (cached && cached !== state) throw new Error('Conflicting world operation fence brand');
    worldStates.set(world, state);
    return state;
  }
  if (cached) return cached;

  // C02 tests and trusted adapters may use a structural fake world. Give each
  // unbranded object the same exclusion semantics without requiring model internals.
  const state = {active: null, reservation: null, initializing: false};
  worldStates.set(world, state);
  return state;
}

/** Create the closure-owned fence used by a real world before it is published. */
export function createWorldOperationFence(): WorldOperationFence {
  const handle = Object.freeze({});
  fenceStates.set(handle, {active: null, reservation: null, initializing: false});
  return handle;
}

/** Register the real world against its closure-owned fence exactly once. */
export function registerWorldOperationFence(world: object, fence: WorldOperationFence): void {
  if (worldStates.has(world)) throw new Error('World operation fence is already registered');
  const state = fenceStates.get(fence);
  if (!state) throw new Error('Unknown world operation fence');
  if (REAL_WORLD_OPERATION_FENCE in world) throw new Error('World already has an operation fence brand');
  Object.defineProperty(world, REAL_WORLD_OPERATION_FENCE, {
    value: fence, enumerable: true, configurable: false, writable: false,
  });
  worldStates.set(world, state);
}

/** World reset/dispose may run only between fenced host operations. */
export function assertWorldOperationIdle(fence: WorldOperationFence): void {
  const state = fenceStates.get(fence);
  if (!state) throw new Error('Unknown world operation fence');
  if (state.active !== null) throw new Error('World operation is active');
}

/** Raw world mutation is unavailable while a supervisor initializes its clients. */
export function assertWorldNotInitializing(fence: WorldOperationFence): void {
  const state = fenceStates.get(fence);
  if (!state) throw new Error('Unknown world operation fence');
  if (state.initializing) throw new Error('World controller initialization is active');
}

/**
 * Reserve a world synchronously for one measured supervisor. The reservation is
 * also the initialization operation owner until finishWorldOperationReservation.
 */
export function reserveWorldOperation(world: object): WorldOperationReservation {
  const state = stateForWorld(world);
  if (state.active !== null || state.reservation !== null) {
    throw new Error('World operation is already reserved or active');
  }
  const reservation = Object.freeze({});
  state.reservation = reservation;
  state.active = reservation;
  state.initializing = true;
  return reservation;
}

/** Finish successful initialization while keeping the lifetime reservation. */
export function finishWorldOperationReservation(
  world: object, reservation: WorldOperationReservation,
): void {
  const state = stateForWorld(world);
  if (state.reservation !== reservation) throw new Error('World reservation owner mismatch');
  if (state.active === null && !state.initializing) return; // Idempotent after finish.
  if (state.active !== reservation || !state.initializing) {
    throw new Error('World initialization fence owner mismatch');
  }
  state.active = null;
  state.initializing = false;
}

/** Release a lifetime reservation after failed-init cleanup or supervisor disposal. */
export function releaseWorldOperationReservation(
  world: object, reservation: WorldOperationReservation,
): void {
  const state = stateForWorld(world);
  if (state.reservation !== reservation) {
    if (releasedReservations.get(reservation) === world) return;
    throw new Error('World reservation owner mismatch');
  }
  if (state.active !== null && !(state.active === reservation && state.initializing)) {
    throw new Error('Cannot release a world reservation during an active boundary');
  }
  state.active = null;
  state.reservation = null;
  state.initializing = false;
  releasedReservations.set(reservation, world);
}

/**
 * Enter one C02 operation or one C04 operation owned by the matching reservation.
 * The returned release closure is owner-bound and idempotent.
 */
export function enterWorldOperation(
  world: object, reservation?: WorldOperationReservation,
): WorldOperationRelease {
  const state = stateForWorld(world);
  if (state.active !== null) throw new Error('World operation already in progress');
  if (state.reservation !== null) {
    if (reservation !== state.reservation) throw new Error('World is reserved by a measured supervisor');
    if (state.initializing) throw new Error('Measured supervisor initialization is active');
  } else if (reservation !== undefined) {
    throw new Error('World reservation is no longer active');
  }

  const operation = Object.freeze({});
  state.active = operation;
  let released = false;
  return () => {
    if (released) return;
    if (state.active !== operation) throw new Error('World operation release owner mismatch');
    state.active = null;
    released = true;
  };
}

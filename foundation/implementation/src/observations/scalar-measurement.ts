import type {RunIdentity, Channel, Tick, Sample} from '../../../contracts/runtime.ts';

export type ScalarTruth = {readonly validity: 'valid'; readonly values: readonly [number]}
  | {readonly validity: 'invalid'; readonly values: readonly []};
export type ScalarSource = Pick<Channel, 'id' | 'kind' | 'size' | 'unit' | 'frame' | 'definition_sha256'>;
export type ScalarMeasurementConfig = {
  readonly source: ScalarSource; readonly channel: Channel;
  readonly capture_stage: 'kinematics' | 'velocity' | 'acceleration' | 'post-solve';
  readonly stride: number; readonly phase: number; readonly delay_ticks: number;
  readonly max_age: number | null; readonly max_pending: number;
  readonly noise: {readonly algorithm: 'xorshift32-13-17-5-u32-v1';
    readonly law: 'uniform-half-open-v1'; readonly seed: number; readonly amplitude: number};
  readonly dropout: 'explicit-invalid'; readonly quantization: 'none'; readonly bounds: 'none';
};
export type ScalarMeasurementSnapshot = {
  readonly identity: RunIdentity; readonly channel: Channel; readonly observed_tick: Tick | null;
  readonly sample: Sample; readonly pending_count: number;
};
type Captured = {validity: 'valid' | 'invalid'; values: number[]; sequence: number;
  capture_tick: Tick; available_tick: Tick};

function check(condition: boolean, message: string): void { if (!condition) throw new Error(message); }
function integer(value: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function record(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): boolean { return typeof value === 'string' && value.length >= 1 && value.length <= 256; }
function digest(value: unknown): boolean {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function copy<T>(value: T): T {
  try { return structuredClone(value); }
  catch { throw new Error('Measurement data must be cloneable'); }
}
function validateIdentity(value: RunIdentity): void {
  check(record(value) && text(value.session_id) && digest(value.project_revision) &&
    integer(value.run_epoch), 'Invalid measurement run identity');
}
function validateConfig(c: ScalarMeasurementConfig): void {
  check(record(c) && record(c.source) && record(c.channel) && record(c.noise), 'Invalid measurement configuration');
  for (const channel of [c.source, c.channel]) {
    check(text(channel.id) && channel.size === 1 && text(channel.unit) &&
      (channel.frame === null || text(channel.frame)) && digest(channel.definition_sha256),
      'Invalid scalar channel metadata');
  }
  check(c.source.kind === 'truth' && c.channel.kind === 'measurement' && c.source.id !== c.channel.id &&
    c.source.unit === c.channel.unit && c.source.frame === c.channel.frame &&
    Array.isArray(c.channel.source_ids) && c.channel.source_ids.length === 1 &&
    c.channel.source_ids[0] === c.source.id, 'Invalid scalar source binding');
  check(integer(c.stride, 1) && integer(c.phase) && c.phase < c.stride && integer(c.delay_ticks) &&
    (c.max_age === null || integer(c.max_age)) && integer(c.max_pending, 1, 4096) &&
    integer(c.phase + c.delay_ticks), 'Invalid measurement schedule or capacity');
  const required = (BigInt(c.delay_ticks) + BigInt(c.stride) - 1n) / BigInt(c.stride);
  check(required <= BigInt(c.max_pending), 'Delay exceeds measurement queue budget');
  check(c.noise.algorithm === 'xorshift32-13-17-5-u32-v1' && c.noise.law === 'uniform-half-open-v1' &&
    integer(c.noise.seed, 1, 4294967295) && Number.isFinite(c.noise.amplitude) && c.noise.amplitude >= 0,
    'Invalid measurement noise definition');
  check(['kinematics', 'velocity', 'acceleration', 'post-solve'].includes(c.capture_stage) &&
    c.dropout === 'explicit-invalid' && c.quantization === 'none' && c.bounds === 'none',
    'Unsupported measurement effect or computation stage');
}

/** Host scheduling only. The world supplies each actual S_k once; retries and views
 * only read. Model binding, computation stage and effect-layer uniqueness are preconditions. */
export function createScalarMeasurement(identity: RunIdentity, config: ScalarMeasurementConfig) {
  let bound = copy(identity);
  const c = copy(config);
  validateIdentity(bound);
  validateConfig(c);
  let lastTick = -1, sequence = 0, rng = c.noise.seed;
  let pending: Captured[] = [];
  let held: Captured | null = null;
  function sameWorld(other: RunIdentity): boolean {
    return other.session_id === bound.session_id && other.project_revision === bound.project_revision;
  }
  return {
    advanceBoundary(identity: RunIdentity, tick: Tick, truth: ScalarTruth): void {
      const request = copy({identity, truth});
      validateIdentity(request.identity);
      check(sameWorld(request.identity) && request.identity.run_epoch === bound.run_epoch,
        'Measurement boundary belongs to another run');
      check(integer(tick) && integer(lastTick + 1) && tick === lastTick + 1,
        'Measurement boundaries must be consecutive from tick zero');
      const value = request.truth;
      check(record(value) && Array.isArray(value.values) &&
        (value.validity === 'invalid' ? value.values.length === 0 : value.validity === 'valid' &&
          value.values.length === 1 && Number.isFinite(value.values[0])), 'Invalid scalar truth input');
      let delivered = 0, nextHeld = held, nextRng = rng, nextSequence = sequence;
      while (delivered < pending.length && pending[delivered].available_tick <= tick) {
        nextHeld = pending[delivered++];
      }
      const nextPending = pending.slice(delivered);
      if (tick >= c.phase && (tick - c.phase) % c.stride === 0) {
        const available = tick + c.delay_ticks;
        check(integer(available) && integer(sequence + 1), 'Measurement timestamp or sequence overflow');
        check(nextPending.length < c.max_pending, 'Measurement queue budget exhausted');
        // One staged draw even for invalid inputs or zero amplitude; never on reads/delivery.
        let x = rng;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        nextRng = x >>> 0;
        nextSequence = sequence + 1;
        const noise = (nextRng / 4294967296 * 2 - 1) * c.noise.amplitude;
        const values = value.validity === 'invalid' ? [] : [value.values[0] + noise];
        check(values.every(Number.isFinite), 'Nonfinite scalar measurement output');
        const captured: Captured = {validity: value.validity, values, sequence: nextSequence,
          capture_tick: tick, available_tick: available};
        if (available === tick) nextHeld = captured;
        else nextPending.push(captured);
      }
      // Nothing above changes existing delivery, queue, RNG, sequence or processed tick.
      pending = nextPending;
      held = nextHeld;
      rng = nextRng;
      sequence = nextSequence;
      lastTick = tick;
    },
    read(): ScalarMeasurementSnapshot {
      const sample: Sample = held === null ? {validity: 'missing', values: [], sequence: null,
        capture_tick: null, available_tick: null} :
        held.validity === 'valid' && c.max_age !== null && lastTick - held.capture_tick > c.max_age ?
          {...held, validity: 'stale'} : held;
      return copy({identity: bound, channel: c.channel, observed_tick: lastTick < 0 ? null : lastTick,
        sample, pending_count: pending.length});
    },
    reset(nextIdentity: RunIdentity): void {
      const next = copy(nextIdentity);
      validateIdentity(next);
      const epoch = bound.run_epoch + 1;
      check(integer(epoch) && sameWorld(next) && next.run_epoch === epoch, 'Reset requires the exact next same-world epoch');
      bound = next;
      lastTick = -1;
      sequence = 0;
      rng = c.noise.seed;
      pending = [];
      held = null;
    },
  };
}

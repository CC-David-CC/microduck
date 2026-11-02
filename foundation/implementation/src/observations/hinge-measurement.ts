import type {RunIdentity, Channel} from '../../../contracts/runtime.ts';
import {createScalarMeasurement, type ScalarMeasurementConfig} from './scalar-measurement.ts';
import type {JointPositionFacts, JointPositionHandle} from '../simulation/mujoco-joint-position.ts';

export type HingeMeasurementEffects = Pick<ScalarMeasurementConfig,
  'stride' | 'phase' | 'delay_ticks' | 'max_age' | 'max_pending' | 'noise' |
  'dropout' | 'quantization' | 'bounds'>;
export type HingeMeasurementRequest = {
  readonly source_id: string; readonly channel_id: string;
  readonly effects: HingeMeasurementEffects;
};
export type HingeMeasurementDescription = {
  readonly facts: JointPositionFacts; readonly source: Channel; readonly channel: Channel;
};
export type HingeMeasurement = {
  describe(): HingeMeasurementDescription;
  advanceBoundary(identity: RunIdentity): void;
  read(): ReturnType<ReturnType<typeof createScalarMeasurement>['read']>;
  reset(nextIdentity: RunIdentity): void;
};

function fail(error?: unknown): Error {
  let message = 'operation failed';
  try {
    if (error instanceof Error && typeof error.message === 'string') message = error.message;
  } catch { /* Keep a bounded fallback for unusual thrown values. */ }
  return new Error(('Hinge measurement ' + message).slice(0, 2000));
}
function copy<T>(value: T): T { return structuredClone(value); }
function finite(value: number): boolean { return typeof value === 'number' && Number.isFinite(value); }
function validFacts(f: JointPositionFacts): void {
  if (!f || f.engine_version !== '3.17.0' || f.quantity !== 'mujoco.qpos' ||
      f.capture_stage !== 'kinematics' || f.joint_type !== 'hinge' || f.native_unit !== 'rad' ||
      typeof f.joint_name !== 'string' || f.joint_name.length < 1 || f.joint_name.length > 256 ||
      f.joint_name.includes('\0') || !Number.isSafeInteger(f.joint_id) || f.joint_id < 0 ||
      !Number.isSafeInteger(f.qpos_address) || f.qpos_address < 0 ||
      !Number.isSafeInteger(f.dof_address) || f.dof_address < 0 ||
      !Number.isSafeInteger(f.body_id) || f.body_id < 0 || !Array.isArray(f.axis) ||
      f.axis.length !== 3 || !finite(f.axis[0]) || !finite(f.axis[1]) || !finite(f.axis[2]) || !finite(f.reference)) {
    throw new Error('Invalid compiled hinge facts');
  }
  for (let i = 0; i < f.joint_name.length; i++) {
    const code = f.joint_name.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = f.joint_name.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid hinge name');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Invalid hinge name');
  }
}
function same(a: JointPositionFacts, b: JointPositionFacts): boolean {
  return a.engine_version === b.engine_version && a.quantity === b.quantity &&
    a.capture_stage === b.capture_stage && a.joint_name === b.joint_name &&
    a.joint_id === b.joint_id && a.joint_type === b.joint_type &&
    a.qpos_address === b.qpos_address && a.dof_address === b.dof_address &&
    a.body_id === b.body_id && a.native_unit === b.native_unit &&
    Object.is(a.reference, b.reference) && a.axis.every((v, i) => Object.is(v, b.axis[i]));
}
function f64(value: number): string {
  const bytes = new ArrayBuffer(8);
  new DataView(bytes).setFloat64(0, value, false);
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function hash(tuple: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(tuple));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createHingeMeasurement(
  identity: RunIdentity, handle: JointPositionHandle, request: HingeMeasurementRequest
): Promise<HingeMeasurement> {
  try {
    const describe = handle?.describe, read = handle?.read;
    if (typeof describe !== 'function' || typeof read !== 'function') {
      throw new Error('Invalid hinge position handle');
    }
    const boundIdentity = copy(identity), input = copy(request);
    const first = copy(describe.call(handle));
    validFacts(first);
    const {effects} = input, {noise} = effects;
    const sourceHash = await hash([
      'brf.hinge-position-source.v1', boundIdentity.project_revision, input.source_id,
      [first.engine_version, first.quantity, first.capture_stage, first.joint_name,
        first.joint_id, first.joint_type, first.qpos_address, first.dof_address, first.body_id,
        first.axis.map(f64), f64(first.reference), first.native_unit],
      ['truth', 1, 'rad', null, []],
    ]);
    const measurementHash = await hash([
      'brf.hinge-position-measurement.v1', sourceHash, input.channel_id,
      ['measurement', 1, 'rad', null, [input.source_id]],
      ['kinematics', effects.stride, effects.phase, effects.delay_ticks,
        effects.max_age, effects.max_pending],
      [noise.algorithm, noise.law, noise.seed, f64(noise.amplitude)],
      [effects.dropout, effects.quantization, effects.bounds],
    ]);
    const later = copy(describe.call(handle));
    if (!same(first, later)) throw new Error('Hinge binding changed during construction');

    const source: Channel = {
      id: input.source_id, kind: 'truth', size: 1, unit: 'rad', frame: null,
      definition_sha256: sourceHash, source_ids: [],
    };
    const channel: Channel = {
      id: input.channel_id, kind: 'measurement', size: 1, unit: 'rad', frame: null,
      definition_sha256: measurementHash, source_ids: [input.source_id],
    };
    const schedulerConfig: ScalarMeasurementConfig = {
      source, channel, capture_stage: 'kinematics',
      stride: effects.stride, phase: effects.phase, delay_ticks: effects.delay_ticks,
      max_age: effects.max_age, max_pending: effects.max_pending,
      noise: {algorithm: noise.algorithm, law: noise.law, seed: noise.seed, amplitude: noise.amplitude},
      dropout: effects.dropout, quantization: effects.quantization, bounds: effects.bounds,
    };
    const scheduler = createScalarMeasurement(boundIdentity, schedulerConfig);
    const description = copy({facts: first, source, channel});
    return {
      describe() {
        try { return copy(description); } catch (error) { throw fail(error); }
      },
      advanceBoundary(next) {
        try {
          const reading = read.call(handle);
          scheduler.advanceBoundary(next, reading.tick, {validity: 'valid', values: [reading.value]});
        } catch (error) { throw fail(error); }
      },
      read() {
        try { return scheduler.read(); } catch (error) { throw fail(error); }
      },
      reset(next) {
        try { scheduler.reset(next); } catch (error) { throw fail(error); }
      },
    };
  } catch (error) { throw fail(error); }
}
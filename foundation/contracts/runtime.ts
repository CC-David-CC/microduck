/** Normative design types, NOT a delivered browser runtime.
 * One snake_case wire schema across adapters. Validate every inbound message at runtime.
 * UI depth, age, panel state and the human camera NEVER enter physical contracts.
 */
export type Tick = number; // finite, non-negative safe integer, not wall time
export type Sha256 = string; // lowercase 64 hex, SHA-256 of exact bytes
export type SessionId = string;
export interface RunIdentity {
  readonly session_id: SessionId;
  readonly project_revision: Sha256;
  readonly run_epoch: number;
}
export type ChannelKind = 'truth' | 'measurement' | 'estimate' | 'command';
export interface Channel {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly size: number;
  readonly unit: string;
  readonly frame: string | null;
  readonly definition_sha256: Sha256;
  readonly source_ids: readonly string[];
}
export type Sample =
  | {readonly validity: 'missing'; readonly values: readonly []; readonly sequence: null;
     readonly capture_tick: null; readonly available_tick: null}
  | {readonly validity: 'valid' | 'invalid' | 'stale' | 'saturated';
     readonly values: readonly number[]; readonly sequence: number;
     readonly capture_tick: Tick; readonly available_tick: Tick};
export interface Observation extends RunIdentity {
  readonly tick: Tick;
  readonly sim_time: number;
  readonly dt: number; // actual elapsed control interval, declared on takeover
  readonly samples: Readonly<Record<string, Sample>>;
}
export interface ControlInput {
  readonly actuator_name: string;
  readonly component: number;
  readonly unit: string;
  readonly semantic: string; // e.g. torque, position target; must be qualified
  readonly input_range: readonly [number, number] | null;
}
/** Compiled host-only mapping. Entire actuator blocks belong to one group. */
export interface ControlBlock {
  readonly actuator_name: string;
  readonly engine_indices: readonly number[];
  readonly inputs: readonly ControlInput[];
  readonly validation_rule_id: string; // includes coupled-vector semantics if applicable
}
export interface GroupBinding {
  readonly group_id: string;
  readonly blocks: readonly ControlBlock[];
}
export interface ModelDescriptor {
  readonly project_revision: Sha256;
  readonly nq: number;
  readonly nv: number;
  readonly actuator_count: number;
  readonly engine_control_size: number;
  readonly timestep: number;
  readonly groups: readonly GroupBinding[];
  readonly channels: readonly Channel[];
}
export interface ControllerDescriptor {
  readonly group_id: string;
  readonly control_size: number; // derived from inputs; equality validated by host
  readonly inputs: readonly ControlInput[];
  readonly control_stride: number;
  readonly observations: readonly Channel[]; // only granted channels, never whole mjData
}
export type Intent = Readonly<Record<string, number>>;
export interface ControlResult<Memory> {
  readonly control: readonly number[]; // this group's width, not global actuator count
  readonly memory: Memory; // candidate until host commit acknowledges it
  readonly diagnostics?: Readonly<Record<string, number>>;
}
export interface Controller<Memory> {
  initialize(descriptor: ControllerDescriptor, parameters: Intent): Memory;
  step(observation: Observation, intent: Intent, memory: Memory):
    ControlResult<Memory> | Promise<ControlResult<Memory>>;
  dispose(): void;
}
export interface ControllerLease {
  readonly group_id: string;
  readonly owner_id: string;
  readonly generation: number;
  readonly control_stride: number;
}
/** Only trusted wrappers mint identity/sequence; code emits candidate ControlResult. */
export interface ActionEnvelope extends RunIdentity {
  readonly group_id: string;
  readonly owner_id: string;
  readonly lease_generation: number;
  readonly observed_tick: Tick;
  readonly apply_tick: Tick;
  readonly sequence: number;
  readonly control: readonly number[];
}
export interface Goal extends RunIdentity {
  readonly group_id: string;
  readonly lease_generation: number;
  readonly target_id: string;
  readonly sequence: number;
  readonly valid_from_tick: Tick;
  readonly valid_until_tick: Tick; // exclusive; default expiry action pauses before step
  readonly values: Intent;
}
/** No untrusted command can assign qpos/ctrl or replace an ownership map. */
export type SessionCommand = RunIdentity & (
  | {readonly kind: 'run'}
  | {readonly kind: 'pause'}
  | {readonly kind: 'step'; readonly steps: number}
  | {readonly kind: 'reset'}
  | {readonly kind: 'set-intent'; readonly expected_intent_revision: number;
     readonly sequence: number; readonly values: Intent}
  | {readonly kind: 'dispose'}
);
export type SessionState = 'staging' | 'ready-paused' | 'running' | 'paused' | 'faulted' | 'disposed';
/** Trusted host surface. Sensor capture remains part of session, not DisplayView. */
export interface DisplayView { dispose(): void; }
export interface SessionHost {
  readonly identity: RunIdentity;
  readonly state: SessionState;
  attach_display(element: HTMLElement): Promise<DisplayView>;
  submit(command: SessionCommand): Promise<void>;
  dispose(): Promise<void>; // idempotent; cancels jobs and fences stale replies
}

/** Design contract; no implementation/browser execution is implied. */
import type {RunIdentity, Sha256, Tick, Intent, Goal} from './runtime.js';
export interface MetricDefinition {
  readonly id: string;
  readonly definition_sha256: Sha256;
  readonly unit: string;
  readonly source_channels: readonly string[];
  readonly window: readonly [Tick, Tick];
  readonly reduction_source: string; // project-confined path + verified source revision
}
export interface ExperimentDefinition {
  readonly schema_version: 1;
  readonly project_revision: Sha256;
  readonly runtime_lock_sha256: Sha256;
  readonly configuration_path: string; // includes initial conditions, cadence, seed streams
  readonly configuration_sha256: Sha256;
  readonly metrics: readonly MetricDefinition[];
  readonly limits: {readonly max_ticks: number; readonly max_wall_ms: number;
    readonly max_output_bytes: number};
  readonly scheduled_inputs_path: string | null;
}
export type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'budget_exhausted';
export interface RunResult {
  readonly attempt_id: string;
  readonly experiment_sha256: Sha256;
  readonly retry_of: string | null;
  readonly status: TerminalStatus;
  readonly goal_success: boolean | null;
  readonly last_committed_tick: Tick;
  readonly metric_values: Readonly<Record<string,
    {readonly valid: boolean; readonly value: number | null; readonly reason: string | null}>>;
  readonly actual_environment_path: string;
  readonly evidence: Readonly<Record<string, Sha256>>;
}
export type Operation = 'inspect' | 'set-intent' | 'create-variation' | 'run' |
  'pause' | 'cancel' | 'measure' | 'compare' | 'save-variation';
/** Held by trusted broker; imported code only has an opaque revocable token. */
export interface InvestigatorGrant {
  readonly session_id: string;
  readonly generation: number; // revocation/authority generation, NOT run_epoch
  readonly authorized_project_revisions: readonly Sha256[];
  readonly grant_id: string;
  readonly operations: readonly Operation[];
  readonly parameter_ranges: Readonly<Record<string, readonly [number, number]>>;
  readonly observation_ids: readonly string[];
  readonly max_runs: number;
  readonly max_total_ticks: number;
  readonly wall_deadline_ms: number;
  readonly max_output_bytes: number;
  readonly destination_ids: readonly string[]; // registered approved destinations, not filesystem handles
}
export type InvestigationRequest = RunIdentity & {readonly grant_id: string; readonly grant_generation: number;
  readonly request_sequence: number} & (
  | {readonly operation: 'inspect'}
  | {readonly operation: 'set-intent'; readonly expected_intent_revision: number;
      readonly values: Intent}
  | {readonly operation: 'create-variation'; readonly base_experiment_sha256: Sha256;
      readonly changes: Intent}
  | {readonly operation: 'run'; readonly experiment_sha256: Sha256; readonly max_ticks: number}
  | {readonly operation: 'pause' | 'cancel'; readonly attempt_id: string}
  | {readonly operation: 'measure'; readonly attempt_id: string; readonly metric_ids: readonly string[]}
  | {readonly operation: 'compare'; readonly attempt_ids: readonly string[]; readonly metric_id: string}
  | {readonly operation: 'save-variation'; readonly draft_revision: Sha256; readonly destination_id: string}
);
export interface SourceBinding {
  readonly source_path: string;
  readonly source_sha256: Sha256;
  readonly symbol: string | null;
  readonly line_range: readonly [number, number] | null;
}
export interface TraceNode {
  readonly id: string;
  readonly kind: 'parameter' | 'source' | 'requested-command' | 'applied-command' |
    'measurement' | 'estimate' | 'metric' | 'physical-property';
  readonly source: SourceBinding | null;
  readonly definition_sha256: Sha256;
}
/** A provenance edge is not proof of a causal claim. */
export interface TraceEdge { readonly from: string; readonly to: string;
  readonly delay_ticks: number; }
export type HighLevelGoal = Goal; // same target contract, not a second agent representation

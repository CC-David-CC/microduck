import type { MetricDefinition, RunResult, TerminalStatus } from '../../../contracts/experiments.ts';
import type { Sha256 } from '../../../contracts/runtime.ts';

export interface PlannedAttempt {
  readonly attempt_id: string;
  readonly experiment_sha256: Sha256;
  readonly retry_of: string | null;
}
export interface ComparisonDefinition {
  readonly metric: MetricDefinition;
  readonly goal_definition_sha256: Sha256 | null;
  readonly comparable_experiments: readonly {
    readonly experiment_sha256: Sha256;
    readonly metric: MetricDefinition;
    readonly goal_definition_sha256: Sha256 | null;
  }[];
}
export interface ComparisonRow extends PlannedAttempt {
  status: TerminalStatus | 'missing';
  result: RunResult | null;
  included_in_mean: boolean;
  mean_exclusion_reason: 'missing_result' | 'not_completed' | 'missing_metric' |
    'invalid_metric' | 'nonfinite_metric' | null;
}
export interface ComparisonSummary {
  metric: MetricDefinition;
  goal_definition_sha256: Sha256 | null;
  rows: ComparisonRow[];
  counts: {
    planned_count: number; completed_count: number; goal_success_count: number;
    failed_count: number; cancelled_count: number; interrupted_count: number;
    budget_exhausted_count: number; missing_count: number; valid_metric_count: number;
  };
  conditional_mean: {
    population: 'completed attempts with declared-valid finite values for the selected metric';
    attempt_ids: string[]; membership_count: number; value: number | null;
  };
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const sha256 = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const statuses: readonly TerminalStatus[] = ['completed', 'failed', 'cancelled', 'interrupted', 'budget_exhausted'];

function validateMetric(metric: MetricDefinition): void {
  if (!metric || !nonempty(metric.id) || !sha256(metric.definition_sha256) || typeof metric.unit !== 'string' ||
      !Array.isArray(metric.source_channels) || !nonempty(metric.reduction_source) ||
      !Array.isArray(metric.window) || metric.window.length !== 2 ||
      !Number.isSafeInteger(metric.window[0]) || !Number.isSafeInteger(metric.window[1]) ||
      metric.window[0] < 0 || metric.window[1] < metric.window[0]) throw new Error('invalid metric definition');
  for (const channel of metric.source_channels) if (!nonempty(channel)) throw new Error('invalid metric channel');
}
function sameMetric(a: MetricDefinition, b: MetricDefinition): boolean {
  return a.id === b.id && a.definition_sha256 === b.definition_sha256 && a.unit === b.unit &&
    a.reduction_source === b.reduction_source && a.window[0] === b.window[0] && a.window[1] === b.window[1] &&
    a.source_channels.length === b.source_channels.length && a.source_channels.every((id, i) => id === b.source_channels[i]);
}
function conditionalMean(values: readonly number[]): number | null {
  if (!values.length) return null;
  // Every finite binary64 is an integer multiple of 2^-1074. Preserve those
  // units exactly so overflow and cancellation cannot erase a small residual.
  const view = new DataView(new ArrayBuffer(8));
  let sum = 0n;
  for (const value of values) {
    view.setFloat64(0, value, false);
    const bits = view.getBigUint64(0, false);
    const exponent = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & ((1n << 52n) - 1n);
    const units = exponent === 0 ? fraction : (fraction | (1n << 52n)) << BigInt(exponent - 1);
    sum += bits >> 63n ? -units : units;
  }
  if (sum === 0n) return 0; // Exact zero has an explicit positive-zero policy.
  const negative = sum < 0n, magnitude = negative ? -sum : sum, count = BigInt(values.length);
  // Choose the 53-bit significand scale; subnormals cannot use units below 2^-1074.
  let shift = Math.max(0, magnitude.toString(2).length - count.toString(2).length - 52);
  if (shift > 0 && magnitude < (count << BigInt(shift + 52))) shift--;
  const divisor = count << BigInt(shift);
  let rounded = magnitude / divisor;
  const twiceRemainder = 2n * (magnitude % divisor);
  if (twiceRemainder > divisor || (twiceRemainder === divisor && (rounded & 1n) !== 0n)) rounded++;
  if (rounded === (1n << 53n)) { rounded >>= 1n; shift++; }
  const mean = Number(rounded) * 2 ** (shift - 1074);
  if (!Number.isFinite(mean)) throw new Error('nonfinite conditional mean');
  return negative ? -mean : mean; // Negative nonzero underflow retains -0.
}

/** The host verifies definition bytes, declares comparability and preserves the
 * original plan. This pure summary neither proves those facts nor runs trials. */
export function summarizeComparison(planned: readonly PlannedAttempt[], results: readonly RunResult[],
  definition: ComparisonDefinition): ComparisonSummary {
  if (!Array.isArray(planned) || !Array.isArray(results) || !Array.isArray(definition.comparable_experiments)) {
    throw new Error('invalid comparison lists');
  }
  validateMetric(definition.metric);
  if (definition.goal_definition_sha256 !== null && !sha256(definition.goal_definition_sha256)) {
    throw new Error('invalid goal definition');
  }
  const comparable = new Set<string>();
  for (const bound of definition.comparable_experiments) {
    validateMetric(bound.metric);
    if (!sha256(bound.experiment_sha256) || comparable.has(bound.experiment_sha256) ||
        !sameMetric(definition.metric, bound.metric) || bound.goal_definition_sha256 !== definition.goal_definition_sha256) {
      throw new Error('conflicting or duplicate comparison definition');
    }
    comparable.add(bound.experiment_sha256);
  }
  const byPlan = new Map<string, PlannedAttempt>();
  for (const plan of planned) {
    if (!nonempty(plan.attempt_id) || byPlan.has(plan.attempt_id) || !comparable.has(plan.experiment_sha256) ||
        (plan.retry_of !== null && (!nonempty(plan.retry_of) || plan.retry_of === plan.attempt_id))) {
      throw new Error('invalid, duplicate or undeclared planned attempt');
    }
    byPlan.set(plan.attempt_id, plan);
  }
  const checked = new Set<string>();
  for (const plan of planned) {
    const chain = new Set<string>();
    let current: PlannedAttempt | undefined = plan;
    while (current && !checked.has(current.attempt_id)) {
      if (chain.has(current.attempt_id)) throw new Error('cyclic retry chain');
      chain.add(current.attempt_id);
      current = current.retry_of === null ? undefined : byPlan.get(current.retry_of);
    }
    for (const id of chain) checked.add(id);
  }
  const byResult = new Map<string, RunResult>();
  for (const result of results) {
    const plan = byPlan.get(result.attempt_id);
    if (!plan || byResult.has(result.attempt_id) || result.experiment_sha256 !== plan.experiment_sha256 ||
        result.retry_of !== plan.retry_of || !statuses.includes(result.status)) throw new Error('invalid result binding or status');
    if ((result.goal_success !== null && typeof result.goal_success !== 'boolean') ||
        (result.goal_success === true && result.status !== 'completed') ||
        (result.goal_success !== null && definition.goal_definition_sha256 === null)) throw new Error('invalid goal outcome');
    if (!Number.isSafeInteger(result.last_committed_tick) || result.last_committed_tick < 0) throw new Error('invalid result tick');
    if (!result.metric_values || typeof result.metric_values !== 'object' || Array.isArray(result.metric_values)) {
      throw new Error('invalid metric values');
    }
    if (Object.hasOwn(result.metric_values, definition.metric.id)) {
      const measurement = result.metric_values[definition.metric.id];
      if (!measurement || typeof measurement.valid !== 'boolean' ||
          (measurement.value !== null && typeof measurement.value !== 'number') ||
          (measurement.reason !== null && typeof measurement.reason !== 'string')) throw new Error('invalid selected metric record');
    }
    byResult.set(result.attempt_id, result);
  }
  const counts: ComparisonSummary['counts'] = { planned_count: planned.length, completed_count: 0, goal_success_count: 0,
    failed_count: 0, cancelled_count: 0, interrupted_count: 0, budget_exhausted_count: 0, missing_count: 0, valid_metric_count: 0 };
  const attemptIds: string[] = [], values: number[] = [];
  const rows: ComparisonRow[] = planned.map(plan => {
    const result = byResult.get(plan.attempt_id);
    const status = result?.status ?? 'missing';
    const measurement = result && Object.hasOwn(result.metric_values, definition.metric.id)
      ? result.metric_values[definition.metric.id] : undefined;
    const finiteValid = measurement?.valid === true && typeof measurement.value === 'number' && Number.isFinite(measurement.value);
    counts[`${status}_count`]++;
    if (result?.goal_success === true) counts.goal_success_count++;
    if (finiteValid) counts.valid_metric_count++;
    const reason: ComparisonRow['mean_exclusion_reason'] = !result ? 'missing_result' : status !== 'completed' ? 'not_completed' :
      !measurement ? 'missing_metric' : !measurement.valid ? 'invalid_metric' : !finiteValid ? 'nonfinite_metric' : null;
    if (reason === null) { attemptIds.push(plan.attempt_id); values.push(measurement!.value!); }
    return { attempt_id: plan.attempt_id, experiment_sha256: plan.experiment_sha256, retry_of: plan.retry_of,
      status, result: result ? structuredClone(result) : null, included_in_mean: reason === null, mean_exclusion_reason: reason };
  });
  return { metric: structuredClone(definition.metric), goal_definition_sha256: definition.goal_definition_sha256,
    rows, counts,
    conditional_mean: { population: 'completed attempts with declared-valid finite values for the selected metric',
      attempt_ids: attemptIds, membership_count: attemptIds.length, value: conditionalMean(values) } };
}

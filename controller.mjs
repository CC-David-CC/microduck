// Trusted Microduck adapter for the existing staged controller protocol.
// Only the supervisor may commit the returned memory after a successful step.
export function createMicroduckController(policy) {
  if (!policy || typeof policy.evaluate !== 'function' || typeof policy.close !== 'function') {
    throw new Error('Invalid Microduck policy');
  }
  let disposal = null;
  return Object.freeze({
    initialize() {
      if (disposal) throw new Error('Controller is closed');
      return Array(14).fill(0);
    },
    async step(observation, intent, committedMemory) {
      if (disposal) throw new Error('Controller is closed');
      const sample = observation?.samples?.['microduck.truth'];
      if (!Number.isSafeInteger(observation?.tick) || observation.tick < 0 ||
          !sample || sample.capture_tick !== observation.tick || sample.available_tick !== observation.tick) {
        throw new Error('Microduck truth is missing or stale');
      }
      const result = await policy.evaluate(sample, committedMemory, intent?.speed, intent?.turn === undefined ? 0 : intent.turn);
      if (disposal) throw new Error('Controller is closed');
      const valid = values => Array.isArray(values) && values.length === 14 &&
        values.every(value => typeof value === 'number' && Number.isFinite(value));
      if (!result || !valid(result.action) || !valid(result.control)) {
        throw new Error('Invalid Microduck policy result');
      }
      return {control: [...result.control], memory: [...result.action]};
    },
    dispose() {
      if (!disposal) disposal = Promise.resolve().then(() => policy.close());
      return disposal;
    }
  });
}

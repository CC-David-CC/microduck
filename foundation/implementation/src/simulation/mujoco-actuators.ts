import type {MainModule, MjModel, MjData} from '@mujoco/mujoco';

type Span = {address: number; size: number};
type InputName = {status: 'available'; value: string} | {status: 'absent'} | {status: 'unsupported'};
export type CompiledActuatorFacts = {
  actuator_count: number; control_size: number; force_size: number; activation_size: number;
  reset_control: number[];
  actuators: Array<{
    id: number; name: string | null; control: Span; force: Span; activation: Span;
    inputs: Array<{index: number; component: number; name: InputName;
      limited: boolean; range: [number, number]}>;
    gain_type: number; bias_type: number; dynamics_type: number;
    transmission_type: number; control_spec: number;
    force_limit: {limited: boolean; range: [number, number]};
  }>;
};

/** Copy fresh compiled facts from the qualified MuJoCo 3.17.0 binding. This is
 * neither a control-semantic compiler nor a validator for arbitrary model data. */
export function readCompiledActuators(mj: MainModule, model: MjModel, data: MjData): CompiledActuatorFacts {
  const range = (values: ArrayLike<number>, index: number): [number, number] =>
    [values[2 * index], values[2 * index + 1]];

  function inputName(id: number, component: number, width: number): InputName {
    const gain = model.actuator_gaintype[id];
    const spec = model.actuator_ctrlspec[id];
    // These C cases return NULL. The pinned std::string wrapper does not check
    // NULL, so it must never be called here. Do not filter its accidental output.
    if ((gain === mj.mjtGain.mjGAIN_FIXED.value || gain === mj.mjtGain.mjGAIN_AFFINE.value) &&
        spec === 0 && width === 1) return {status: 'absent'};
    if (gain === mj.mjtGain.mjGAIN_SO3.value && spec === mj.mjtCtrlChart.mjCHART_QUAT.value && width === 4) {
      return {status: 'available', value: mj.mj_actuatorInputName(model, id, component)};
    }
    return {status: 'unsupported'};
  }

  const actuators: CompiledActuatorFacts['actuators'] = [];
  for (let id = 0; id < model.nactuator; id++) {
    const nameAddress = model.name_actuatoradr[id];
    if (!Number.isSafeInteger(nameAddress) || nameAddress < 0 || nameAddress >= model.names.length) {
      throw new Error(`Invalid compiled actuator name address for actuator ${id}`);
    }
    // names is signed Int8Array. Nonzero, including a negative UTF-8 byte, means
    // a present name; only then is the nullable ID-to-name wrapper safe to call.
    const name = model.names[nameAddress] === 0 ? null :
      mj.mj_id2name(model, mj.mjtObj.mjOBJ_ACTUATOR.value, id);
    const control = {address: model.actuator_ctrladr[id], size: model.actuator_ctrlnum[id]};
    const inputs: CompiledActuatorFacts['actuators'][number]['inputs'] = [];
    for (let component = 0; component < control.size; component++) {
      const index = control.address + component;
      inputs.push({index, component, name: inputName(id, component, control.size),
        limited: model.actuator_ctrllimited[index] !== 0,
        range: range(model.actuator_ctrlrange, index)});
    }
    actuators.push({id, name, control,
      force: {address: model.actuator_outadr[id], size: model.actuator_outnum[id]},
      activation: {address: model.actuator_actadr[id], size: model.actuator_actnum[id]},
      inputs, gain_type: model.actuator_gaintype[id], bias_type: model.actuator_biastype[id],
      dynamics_type: model.actuator_dyntype[id], transmission_type: model.actuator_trntype[id],
      control_spec: model.actuator_ctrlspec[id],
      force_limit: {limited: model.actuator_forcelimited[id] !== 0,
        range: range(model.actuator_forcerange, id)}});
  }
  return {actuator_count: model.nactuator, control_size: model.nu, force_size: model.nout,
    activation_size: model.na, reset_control: Array.from(data.ctrl as Float64Array), actuators};
}

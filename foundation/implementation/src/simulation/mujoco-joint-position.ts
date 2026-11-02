import type {MainModule, MjModel} from '@mujoco/mujoco';

export type JointPositionFacts = {
  engine_version: '3.17.0'; quantity: 'mujoco.qpos'; capture_stage: 'kinematics';
  joint_name: string; joint_id: number; joint_type: 'hinge' | 'slide';
  qpos_address: number; dof_address: number; body_id: number;
  axis: [number, number, number]; reference: number; native_unit: 'rad' | 'model-length';
};
export type JointPositionHandle = {
  describe(): JointPositionFacts;
  read(): {tick: number; time: number; value: number};
};

/** Copy facts from the existing plant's compiled model. No native handle escapes.
 * The generalized coordinate retains its reference and model units. */
export function readJointPositionFacts(mj: MainModule, model: MjModel, name: string): JointPositionFacts {
  try {
    if (typeof name !== 'string' || name.length < 1 || name.length > 256 || name.includes('\0')) {
      throw new Error('Joint name must contain 1..256 UTF-16 units without NUL');
    }
    for (const character of name) {
      const point = character.codePointAt(0)!;
      if (point >= 0xd800 && point <= 0xdfff) throw new Error('Joint name contains an unpaired surrogate');
    }
    const index = (value: number, count: number) =>
      Number.isSafeInteger(value) && Number.isSafeInteger(count) && value >= 0 && value < count;
    const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, name);
    if (!index(id, model.njnt)) throw new Error('Joint name does not resolve to a compiled joint');
    const type = model.jnt_type[id];
    const hinge = type === mj.mjtJoint.mjJNT_HINGE.value;
    if (!hinge && type !== mj.mjtJoint.mjJNT_SLIDE.value) throw new Error('Joint position requires a hinge or slide');
    const qpos = model.jnt_qposadr[id], dof = model.jnt_dofadr[id], body = model.jnt_bodyid[id];
    if (!index(qpos, model.nq) || !index(qpos, model.qpos0.length) ||
        !index(dof, model.nv) || !index(body, model.nbody)) throw new Error('Invalid compiled joint address');
    const axis: [number, number, number] =
      [model.jnt_axis[3 * id], model.jnt_axis[3 * id + 1], model.jnt_axis[3 * id + 2]];
    const reference = model.qpos0[qpos];
    if (!Number.isFinite(reference) || !axis.every(Number.isFinite)) throw new Error('Nonfinite compiled joint facts');
    return {engine_version: '3.17.0', quantity: 'mujoco.qpos', capture_stage: 'kinematics',
      joint_name: name, joint_id: id, joint_type: hinge ? 'hinge' : 'slide',
      qpos_address: qpos, dof_address: dof, body_id: body, axis, reference,
      native_unit: hinge ? 'rad' : 'model-length'};
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Compiled joint lookup failed';
    throw new Error(('Joint position binding failed: ' + reason).slice(0, 2000));
  }
}

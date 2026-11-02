import type {MainModule, MjModel} from '@mujoco/mujoco';
import {readJointPositionFacts} from './mujoco-joint-position.ts';

export type JointVelocityFacts = {
  engine_version: '3.17.0'; quantity: 'mujoco.qvel'; capture_stage: 'velocity';
  joint_name: string; joint_id: number; joint_type: 'hinge' | 'slide';
  qvel_address: number; body_id: number; axis: [number, number, number];
  native_unit: 'rad/s' | 'model-length/s';
};
export type JointVelocityHandle = {
  describe(): JointVelocityFacts;
  read(): {tick: number; time: number; value: number};
};

/** Project validated scalar joint metadata onto the native generalized velocity. */
export function readJointVelocityFacts(mj: MainModule, model: MjModel, name: string): JointVelocityFacts {
  try {
    const position = readJointPositionFacts(mj, model, name);
    const qvel = model.jnt_dofadr[position.joint_id];
    if (!Number.isSafeInteger(qvel) || qvel < 0 || qvel >= model.nv || qvel !== position.dof_address) {
      throw new Error('Invalid compiled joint velocity address');
    }
    return {engine_version: '3.17.0', quantity: 'mujoco.qvel', capture_stage: 'velocity',
      joint_name: position.joint_name, joint_id: position.joint_id, joint_type: position.joint_type,
      qvel_address: qvel, body_id: position.body_id, axis: [...position.axis],
      native_unit: position.joint_type === 'hinge' ? 'rad/s' : 'model-length/s'};
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Compiled velocity lookup failed';
    throw new Error(('Joint velocity binding failed: ' + reason).slice(0, 2000));
  }
}

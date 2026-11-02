/** Guard the pinned module's filesystem against native write and mapping paths. */
export function guardProjectMutations(fs: any, onDenied: () => void): Record<string, any> {
  const methods = ['write','unlink','rmdir','mkdir','rename','symlink','link','mknod','create',
    'truncate','ftruncate','chmod','fchmod','lchmod','chown','fchown','lchown','utime','mount','unmount',
    'createDataFile','createPath','createDevice','createLazyFile','createPreloadedFile','mmap','msync'];
  const original: Record<string, any> = Object.create(null);
  for (const name of methods) {
    original[name] = fs[name];
    if (typeof original[name] !== 'function') continue;
    fs[name] = function() { onDenied(); throw new fs.ErrnoError(44); };
  }
  return original;
}

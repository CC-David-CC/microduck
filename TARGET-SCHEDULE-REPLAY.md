# Saved target schedule replay checkpoint

A saved, structurally inspected and explicitly unverified target history can be replayed in a fresh session of the identical project revision. A session attempt lease owns target changes and steps for the duration, excluding competing control operations. The replay requires a target at tick zero, a single source session and epoch, accepted and permitted values, at most 256 entries and 4096 steps. It reports cancellation or unknown outcomes rather than asserting completion when a dispatched operation is uncertain. It does not restore a full checkpoint, prove the original experiment ran, validate all measurements, or establish scientific reproducibility.

Evidence on [local build host], Linux 7.0.0-38-generic x86_64, Node v24.22.1, Chromium 156.0.8078.4 headless, isolated local desktop and separately served runner, MuJoCo 3.17.0 and Microduck policy:

- Failing-before-implementation acceptance logs: `[local path]` and `codi-replay-schedule-red.log`.
- `node tests/browser/desktop-shell-browser.mjs` opened the actual desktop app, exercised permissioned agent and human drive, saved and reopened via isolated My files, replayed the recorded targets through 400 steps and closed; one browser test passed, no page errors. Compared to the retained forward native reference, maximum absolute differences were 9.008627177564676e-13 in qpos and 1.0171072317710639e-11 in qvel. Raw output: `[local path]`; runner request evidence: `codi-replay-schedule.requests.jsonl`.
- `node --test` over the replay, lease, project preparation, saved target, drive, file, desktop, loader, policy, world and cleanup tests: 57 passed, 0 failed, 0 skipped. Full test list and raw TAP output: `[local path]`.

The test uses an isolated local desktop, not the deployed desktop, and does not establish real-device graphics performance. The replay currently covers target schedules only; imported histories remain unverified and initial conditions and other experiment details are not restored by this feature.

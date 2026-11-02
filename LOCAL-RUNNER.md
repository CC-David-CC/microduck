# Local Microduck runner for desktop integration

Microduck runs its controller in a credentialless frame and worker on a different origin. This loopback-only server provides a repeatable **isolated local preview**, not a production service. Do not expose it to the Internet or serve the runner on the desktop identity origin.

After installing the app's locked Node dependencies, obtain the pinned policy and prepare the project and retrieve the qualified no-eval engine as described in PROJECT-SOURCE.md. Build the desktop app catalog using CodiServer's build-public-apps.py, and build the runner into a new empty directory:

```sh
cd apps/system/microduck
MICRODUCK_APP_ORIGIN=http://127.0.0.1:19682 \
MICRODUCK_POLICY=/path/to/alpha_walking.onnx \
MICRODUCK_RUNNER_OUT=/path/to/new-empty-runner \
node tools/build-runner.mjs
python3 tools/serve-local-runner.py --directory /path/to/new-empty-runner \
  --app-origin http://127.0.0.1:19682 --port 19683
```

In a second terminal, from the repository root, launch the isolated desktop using an environment with its Python dependencies:

```sh
python3 active-system/scripts/run-simplified-local.py --isolated --port 19682 \
  --apps-bundle /path/to/built-desktop-app-catalog \
  --microduck-runner-origin http://127.0.0.1:19683
```

The loopback desktop and runner ports must differ. The app origin used to build the runner must match the preview origin exactly; the runner verifies its built inventory and origin before listening. The server serves only the named runner files, accepts the desktop's one-time frame challenge, uses a restricted frame policy, and gives the worker the narrower WASM policy. It does not serve desktop account data or set cookies. These checks catch accidental configuration and corruption; a manifest is not proof that source or a controller is safe.

For a managed desktop, the integrator must choose and control a distinct HTTPS runner origin, build the runner for the actual desktop origin, serve the files and their corresponding response policies, supply that runner origin via the desktop's trusted configuration, and allow only that origin in the desktop document's `frame-src`. Ingress, certificate, deployment and production CSP are not configured by these local commands. The included Python server is not a production deployment. Consult DESKTOP-INTEGRATION-HANDOFF.md before integration.

## Evidence

On [local build host], Linux 7.0.0-38-generic x86_64, Python 3.14.4, Node 24.22.1 and headless Chromium 156.0.8078.4, the new server and actual isolated desktop completed the full desktop test: open, show and run the real duck, switch surfaces, permissioned agent/human drive, save/reopen, 400-step target replay, and cleanup. The final qpos/qvel maxima against the retained native reference were 9.008627177564676e-13 and 1.0171072317710639e-11. Raw output: `[local path]`.

The first desktop attempt failed because the server rejected the frame's challenge query; `codi-runner-http-desktop.log` and `codi-runner-challenge-red.log` retain that failure. The corrected route has an independent HTTP regression. The HTTP suite passed 3 tests (`codi-runner-http-unit-final.log`); 58 Node cumulative tests passed, zero failed or skipped (`codi-runner-http-cumulative.log`), and the additional origin-zero regression passed separately. These logs are in the same artifact directory. The final runner build was byte-identical to the browser-tested build. No actual external desktop deployment, real-device performance, or general isolation certification is asserted.

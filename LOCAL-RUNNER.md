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

For the reference `serve-connected.py` issuer, an operator can specify `--microduck-runner-origin https://runner.example` alongside the actual desktop `--origin https://desktop.example`. It exposes that exact origin in trusted configuration and extends the top-level document frame policy, preserving its existing sources. The option defaults off, accepts HTTPS only, and requires a distinct origin. `--apps-bundle /path/to/catalog` selects the explicitly built app catalog. This is source-level reference integration, not a release profile or a deployment.

For a managed desktop, the integrator must choose and control a distinct HTTPS runner origin, build the runner for the actual desktop origin, serve the files and their corresponding response policies, supply that runner origin via the desktop's trusted configuration, and allow only that origin in the desktop document's `frame-src`. A reverse proxy that replaces CSP must preserve the same frame source; an upstream issuer header alone is insufficient. Ingress, certificate, deployment and production CSP are not configured by these local commands. The included Python server is not a production deployment. Consult DESKTOP-INTEGRATION-HANDOFF.md before integration.

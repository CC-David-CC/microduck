# Foundation intake and staged controller checkpoint

The source was copied from the unreviewed browser-robotics Microduck
simple-view candidate on [local build host]. The two isolation files were replaced with
the earlier non-diagnostic runner files after a diff confirmed the candidate's
changes were the test-only ONNX global and asset bridge. The app-global
diagnostic session export was removed. This is an integration candidate, not
an installed desktop app, a complete source review, or a production security
qualification. The ONNX controller is not yet wired into that runner.

The new first-party controller returns policy actions as candidate memory.
The runner/supervisor, not the controller, determines whether the step commits.
Its tests check that an uncommitted result cannot affect the next call and
that stale truth is rejected before inference.

On [local build host] with Node 24.22.1, MuJoCo npm 3.17.0 for the Node-only binding
test, and ONNX Runtime Web 1.31.1 CPU/WASM, the command below produced 13
passes, zero failures and zero skips. It includes policy-reference tests,
two procedural rendering unit tests and four world-controller-binding tests.
This is not Chromium, a live Microduck run, a desktop build, or CSP evidence.

    MICRODUCK_POLICY=/path/to/alpha_walking.onnx node --test tests/controller.test.mjs tests/policy.test.mjs tests/policy-reference.test.mjs tests/onnx-reference.test.mjs foundation/implementation/tests/unit/simple-duck.test.mjs foundation/implementation/tests/unit/world-controller-bind.test.mjs

Raw failure-before-implementation and successful output are in evidence/.
The copied session-display-acceptance test from the source candidate was not
included: it also fails in that original candidate before executing because
its inventory mock omits a newly required export. No existing test assertion
was weakened. The release still requires an independent same-world view-switch
browser test.

The source candidate used a separately rebuilt MuJoCo JS/WASM pair (upstream
commit 800a109a4bdd02cb60404d565db4ae16fb04a53b, Emscripten 4.0.10,
DYNAMIC_EXECUTION=0, threads off). The ordinary npm package used in the
Node check is not that build and is not approved for the strict browser CSP.
Build provenance, browser behavior and packaging must be qualified before the
app can be offered for integration.

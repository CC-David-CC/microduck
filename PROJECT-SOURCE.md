# Microduck built-in project source

The current built-in steering-enabled project revision is `0183b6ea156fbb779121ecdb9b4c0ee205cdfec652eb427c4326b1064868ac2a` and its generated file SHA-256 is `7bed18ccb5ee0da8d6939f8ce43fb4272fea35b82f357f0be4db92d28b4b63f2`. The old reconstruction hash below documents the earlier speed-only version. Its saved projects are not admitted by the current single-revision trusted opener.

The tracked project-source directory contains the derivative MuJoCo scene,
experience text, target declaration and exact manifest used in the live
Microduck tests. The scene is a derivative, not a verbatim copy of the
upstream robot XML: it preserves the qualified STAND keyframe and collision
meshes used by the reference trajectory. The upstream Space and policy are
Apache-2.0; the included assets/MICRODUCK-LICENSE.txt retains its license.

Obtain the pinned public source into a suitable artifact volume, for example
using the Hugging Face CLI:

    hf download pollen-robotics/microduck-simulator --type space --revision ad9d41a763f30dc770817c33d92dcfec0205db1e --include 'app/public/robot/mjlab/meshes/*.stl' --include 'app/public/robot/mjlab/kinematics.json' --local-dir /path/to/space
    hf download pollen-robotics/microduck-policies alpha_walking.onnx --revision 665ae4eb20bfe13bca1ef4ea6d4bb6b4a096e448 --local-dir /path/to/policy

Prepare the generated asset after npm ci (the destination must not exist):

    MICRODUCK_SPACE_DIR=/path/to/space MICRODUCK_POLICY=/path/to/policy/alpha_walking.onnx MICRODUCK_BUILTIN_PROJECT=assets/microduck-project.json node tools/prepare-builtin-project.mjs

The assembler reads only the nine referenced meshes, the policy, the tracked
source files and the built-in adapter declaration. It verifies each file's
size and SHA-256 against the pinned manifest before writing and verifies the
whole generated file's SHA-256. The output matches the previously qualified
fixture byte-for-byte; generated source assets and downloaded binaries stay
outside Git. This does not establish source safety or physical correctness.

On [local build host], Node 24.22.1 reconstructed SHA-256
b32639fc7783f4d1f249f17ed458faf8b9e65ab3cbbdbfdcd844179265a18a82
without the earlier fixture. A modified mesh was rejected before output.
Forty-seven cumulative tests passed, none failed or skipped. The initial
missing-source-tool failure and cumulative output are in evidence/. A later
attempt encountered the /tmp per-user quota; rerunning with TMPDIR on the
artifact volume succeeded. The no-eval MuJoCo build remains a separate pinned
prerequisite, and production runner hosting, CSP, full experiment replay and
release qualification remain unfinished.


## Qualified strict-CSP MuJoCo artifacts

The exact previously qualified no-eval engine files are retained on fleet storage at `[local build host]:[local artifact store]`. Copy that directory to the build machine, then from this app directory after `npm ci` run:

```sh
MICRODUCK_MUJOCO_NOEVAL=/path/to/copied-qualified-engine node tools/prepare-engine.mjs
```

The staging tool checks the exact SHA-256 of all three files before writing the local npm package. On 2026-11-02 the files were copied back from [local build host] to [local build host] and staged in an isolated test; a modified file was rejected before any destination change. A local store copy is not a backup guarantee; the earlier original remains separately on [local build host].

The upstream source and no-JavaScript-evaluation patch are documented in `tools/mujoco-noeval.patch`; `tools/build-noeval-engine-candidate.sh` builds a candidate from a separate pinned source checkout and SDK in a new work directory and refuses to call it qualified unless all three original hashes match. Emscripten 4.0.10, CMake, Ninja, Node and npm are needed; CMake/npm may fetch their pinned dependencies. An independent [local build host] rebuild produced a byte-identical JS file and type declarations with compiler path remapping, but the WASM still differed in LLVM-generated function names. Every non-name WASM section matched byte-for-byte in that diagnosis. The candidate is therefore **not accepted** by the hash gate. Exact cross-directory source-build reproducibility remains unresolved; do not silently replace the qualified artifact with that candidate.

## Published Microduck display rig

The desktop build also needs the pinned visual rig. From the same pinned Space checkout used above, assemble the generated app asset (the destination must not exist):

```sh
MICRODUCK_SPACE_DIR=/path/to/space MICRODUCK_VISUAL_OUTPUT=assets/microduck-visual.json node tools/prepare-microduck-visual.mjs
```

The tool checks the rig and each of its 38 STL meshes against `tools/microduck-visual-manifest.json`. It produces a 6,743,770-byte inert display asset with SHA-256 `ee72047f7773cf2c9ae4f975db38921947bc11a4cb3ef242ed25227d6a452abd`. The app checks the exact digest before rendering. The visual rig follows named simulation bodies; it does not change the model, policy or robot observations. See `PUBLISHED-VISUAL-CHECKPOINT.md` for evidence and differences.

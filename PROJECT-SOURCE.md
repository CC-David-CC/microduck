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

## Qualified strict-CSP MuJoCo artifacts

The build requires the qualified MuJoCo 3.17.0 no-eval runtime files. After
`npm ci`, set `MICRODUCK_MUJOCO_NOEVAL` to the directory containing those
files and run `node tools/prepare-engine.mjs`. The staging tool checks all
three SHA-256 values before writing into the local npm package.

The corresponding source patch and candidate builder are in `tools/`.
An exact cold rebuild of the WASM is still unresolved. Use the qualified
runtime files for the existing build. The public source checkout excludes
the runtime binaries, generated build assets, and local test evidence.

## Published Microduck display rig

The desktop build also needs the pinned visual rig. From the same pinned Space checkout used above, assemble the generated app asset (the destination must not exist):

```sh
MICRODUCK_SPACE_DIR=/path/to/space MICRODUCK_VISUAL_OUTPUT=assets/microduck-visual.json node tools/prepare-microduck-visual.mjs
```

The tool checks the rig and each of its 38 STL meshes against `tools/microduck-visual-manifest.json`. It produces a 6,743,770-byte inert display asset with SHA-256 `ee72047f7773cf2c9ae4f975db38921947bc11a4cb3ef242ed25227d6a452abd`. The app checks the exact digest before rendering. The visual rig follows named simulation bodies; it does not change the model, policy or robot observations. 

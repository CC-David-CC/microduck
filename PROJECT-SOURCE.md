# Microduck built-in project source

The tracked project-source directory contains the derivative MuJoCo scene,
experience text, target declaration and exact manifest used in the live
Microduck tests. The scene is a derivative, not a verbatim copy of the
upstream robot XML: it preserves the qualified STAND keyframe and collision
meshes used by the reference trajectory. The upstream Space and policy are
Apache-2.0; the included assets/MICRODUCK-LICENSE.txt retains its license.

Obtain the pinned public source into a suitable artifact volume, for example
using the Hugging Face CLI:

    hf download pollen-robotics/microduck-simulator --type space --revision ad9d41a763f30dc770817c33d92dcfec0205db1e --include 'app/public/robot/mjlab/meshes/*.stl' --local-dir /path/to/space
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

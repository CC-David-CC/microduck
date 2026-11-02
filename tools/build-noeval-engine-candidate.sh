#!/usr/bin/env bash
# Build a strict-CSP MuJoCo candidate; qualification requires exact hashes.
# Creates a new task directory; never modifies the supplied source or SDK.
set -euo pipefail
if [[ $# != 3 ]]; then echo 'Usage: build-noeval-engine-candidate.sh SOURCE_CHECKOUT EMSDK NEW_WORK_DIRECTORY' >&2; exit 2; fi
source_input=$1
sdk_input=$2
work_input=$3
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
patch="$script_dir/mujoco-noeval.patch"
expected_revision=800a109a4bdd02cb60404d565db4ae16fb04a53b
if [[ ! -d "$source_input/.git" ]] || ! git -C "$source_input" rev-parse --git-dir >/dev/null 2>&1; then echo 'Invalid source checkout' >&2; exit 2; fi
if [[ ! -f "$sdk_input/emsdk_env.sh" || ! -x "$sdk_input/upstream/emscripten/emcc" || ! -x "$sdk_input/upstream/emscripten/emcmake" ]]; then echo 'Invalid Emscripten SDK' >&2; exit 2; fi
if [[ -e "$work_input" || -L "$work_input" ]]; then echo 'Work directory already exists' >&2; exit 2; fi
source_dir=$(realpath "$source_input"); sdk_dir=$(realpath "$sdk_input");work=$(realpath -m "$work_input")
if [[ "$work" =~ [[:space:]] || "$sdk_dir" =~ [[:space:]] ]]; then echo 'Build and SDK paths must not contain whitespace' >&2; exit 2; fi
case "$work/" in "$source_dir/"*|"$sdk_dir/"*) echo 'Work directory must be outside the inputs' >&2; exit 2;; esac
[[ $(git -C "$source_dir" rev-parse HEAD) == "$expected_revision" ]] || { echo 'Unexpected source revision' >&2; exit 2; }
[[ $(sha256sum "$patch" | cut -d ' ' -f 1) == 27e3258414c1dec579a41c850343f9addb952e93723a629cb7bf7a877a2d3454 ]] || { echo 'Unexpected source patch' >&2; exit 2; }
mkdir -- "$work"
git clone --no-hardlinks --no-checkout -- "$source_dir" "$work/source"
git -C "$work/source" checkout --detach "$expected_revision"
git -C "$work/source" apply --check "$patch"
git -C "$work/source" apply "$patch"
# shellcheck disable=SC1091
source "$sdk_dir/emsdk_env.sh" >/dev/null
emcc --version | head -n 1 | grep -F ' 4.0.10 ' >/dev/null || { echo 'Emscripten 4.0.10 required' >&2; exit 2; }
command -v node >/dev/null; command -v npm >/dev/null; command -v cmake >/dev/null; command -v ninja >/dev/null
npm --prefix "$work/source/wasm" ci --ignore-scripts --no-audit --no-fund
export PATH="$work/source/wasm/node_modules/.bin:$PATH"
# Map diagnostic and __FILE__ paths to the original qualified build paths.
# LLVM ThinLTO symbol identifiers can still differ, so hashes remain mandatory.
canonical=[local path]
flags="-ffile-prefix-map=$work/source=$canonical/source -ffile-prefix-map=$sdk_dir=$canonical/emsdk"
emcmake cmake -S "$work/source" -B "$work/build" -G Ninja \
  -DMUJOCO_WASM_THREADS=OFF -DMUJOCO_BUILD_TESTS_WASM=OFF -DMUJOCO_BUILD_STUDIO=OFF \
  -DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags"
cmake --build "$work/build" --target mujoco_wasm --parallel 2
cd "$work/source/wasm/dist"
sha256sum --check <<'HASHES'
694ad7aec441f15507f4392d3fac186d9f6e1e31de60fb6492f3fffab3989e29  mujoco.js
a988f7b4a1b6a31a55b7b8a9cdca5c56930241f627766dddea860aaad742344a  mujoco.wasm
0c4aee031870765b67c52f8482ab8a2e4759a0df42dfc479b80d9f63a8d109c6  mujoco.d.ts
HASHES
printf 'Qualified artifacts: %s\n' "$work/source/wasm/dist"

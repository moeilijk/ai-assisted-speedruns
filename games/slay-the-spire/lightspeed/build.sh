#!/bin/bash
# Builds sts_lightspeed's test binary (the combat oracle) and the aas planner against its sources.
# Usage: build.sh [<sts_lightspeed checkout>]   (default: <repo>/.local/sts_lightspeed, cloned if missing)
set -e
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
LS=${1:-$REPO/.local/sts_lightspeed}
# The commit the patches were made against, pinned in ../UPSTREAM.json (gamerpuppy's sts_lightspeed, MIT; see ../NOTICE).
PIN=$(node -p "require('$HERE/../UPSTREAM.json').sts_lightspeed.commit")
[ -d "$LS" ] || { git clone -q https://github.com/gamerpuppy/sts_lightspeed.git "$LS" && git -C "$LS" checkout -q "$PIN"; }
[ "$(git -C "$LS" rev-parse HEAD)" = "$PIN" ] || echo "note: $LS is not at the pinned commit $PIN; the patches were made against that one" >&2
cd "$LS"; git submodule update --init --depth 1 json >/dev/null 2>&1 || true
# Patches this repo keeps against the upstream checkout (hooks for the planner, corrections to event
# effects measured against the real game). Applied only when they still apply cleanly, so re-running is safe.
for p in "$HERE"/*.patch; do
  [ -e "$p" ] || continue
  if git -C "$LS" apply --check "$p" >/dev/null 2>&1; then git -C "$LS" apply "$p" && echo "applied $(basename "$p")"; fi
done
mkdir -p build/obj
# Recompile whenever the source is newer than its object. With `[ -f "$o" ]` alone a changed source was never
# translated again, so edits silently stayed out of the binary while the build reported success.
# A changed header does not touch the .cpp files that include it, so comparing each source against its own object
# is not enough: the objects that still hold the old struct layout link together into a binary that corrupts its
# own state. The newest header therefore decides as well --, measured:, after a field was added to
# GameContext.h and a playout walked into a map node that does not exist.
newest_header=$(find include -name '*.h' -newer /dev/null -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2)
fail=0
for f in $(find src -name '*.cpp'); do o=build/obj/$(echo "$f" | tr '/' '_').o; { [ -f "$o" ] && [ ! "$f" -nt "$o" ] && { [ -z "$newest_header" ] || [ ! "$newest_header" -nt "$o" ]; }; } || g++ -std=c++17 -O2 -w -Iinclude -Ijson/include -c "$f" -o "$o" || touch build/obj/.failed & done; wait
# The compilers run in the background, so their exit code has to be collected here: without this the script
# reported "built ..." while a source had failed to compile and the old object was linked instead.
if [ -e build/obj/.failed ]; then rm -f build/obj/.failed; echo "build failed" >&2; exit 1; fi
ar rcs build/libsts.a build/obj/*.o
g++ -std=c++17 -O2 -w -Iinclude -Ijson/include apps/test.cpp build/libsts.a -o build/test -pthread
g++ -std=c++17 -O2 -w -Iinclude -Ijson/include "$HERE/aas.cpp" build/libsts.a -o build/aas -pthread
echo "built $LS/build/test and $LS/build/aas"

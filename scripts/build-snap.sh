#!/usr/bin/env bash
# scripts/build-snap.sh — build the quilt-core snap locally.
#
# Usage:
#   ./scripts/build-snap.sh                    # default: build the snap
#   ./scripts/build-snap.sh --debug            # build with debug symbols
#   ./scripts/build-snap.sh --arch=arm64       # cross-build for Pi/Jetson
#   ./scripts/build-snap.sh --output=out/      # where to put the .snap file
#   ./scripts/build-snap.sh --no-build         # skip the snapcraft build
#                                                (just compile TS)
#
# Exit codes:
#   0  success
#   1  generic failure
#   2  missing dependency (snapcraft, lxd, multipass)
#   3  build itself failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT"
ARCH=""
DEBUG=0
SKIP_BUILD=0

# ---------------------------------------------------------------------------
# Defaults pulled from snap/snapcraft.yaml.
# ---------------------------------------------------------------------------
SNAP_NAME="quilt-core"
SNAP_VERSION="$(grep -E '^version:' "$REPO_ROOT/snap/snapcraft.yaml" 2>/dev/null | sed 's/.*"\(.*\)".*/\1/' || echo '0.0.0')"
if [[ -z "$SNAP_VERSION" || "$SNAP_VERSION" == "0.0.0" ]]; then
  SNAP_VERSION="$(git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null || echo '0.0.0-dev')"
fi

# ---------------------------------------------------------------------------
# Argument parsing.
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --debug)        DEBUG=1 ;;
    --no-build)     SKIP_BUILD=1 ;;
    --arch=*)       ARCH="${arg#--arch=}" ;;
    --output=*)     OUTPUT_DIR="${arg#--output=}" ;;
    --version=*)    SNAP_VERSION="${arg#--version=}" ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Pretty logging.
# ---------------------------------------------------------------------------
log() { printf '\033[1;34m[build-snap]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[build-snap]\033[0m %s\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m[build-snap]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Tooling.
# ---------------------------------------------------------------------------
require() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "missing required tool: $cmd (install it and re-run)"
  fi
}

require snapcraft

# Optional: cross-build via lxd.
if [[ -n "$ARCH" ]]; then
  if ! command -v lxd >/dev/null 2>&1 && ! command -v multipass >/dev/null 2>&1; then
    die "cross-build requested ($ARCH) but neither lxd nor multipass is installed"
  fi
fi

# ---------------------------------------------------------------------------
# Step 1. Compile TypeScript.
# ---------------------------------------------------------------------------
log "compiling TypeScript ($REPO_ROOT/src → $REPO_ROOT/dist)"

if [[ ! -f "$REPO_ROOT/tsconfig.json" ]]; then
  cat > "$REPO_ROOT/tsconfig.json" <<'TS'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "snap"]
}
TS
  log "generated a default tsconfig.json"
fi

if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  log "running npm ci"
  (cd "$REPO_ROOT" && npm ci) || die "npm ci failed"
fi

(cd "$REPO_ROOT" && npx tsc -p tsconfig.json) || die "tsc failed"
ok "tsc ok"

# ---------------------------------------------------------------------------
# Step 2. Make hooks executable.
# ---------------------------------------------------------------------------
log "ensuring snap hooks are executable"
chmod 0755 "$REPO_ROOT"/snap/hooks/* 2>/dev/null || true
chmod 0755 "$REPO_ROOT"/snap/local-bin/* 2>/dev/null || true
ok "hooks chmod ok"

# ---------------------------------------------------------------------------
# Step 3. Build the snap with snapcraft.
# ---------------------------------------------------------------------------
if [[ $SKIP_BUILD -eq 1 ]]; then
  ok "skipping snapcraft build (--no-build)"
  exit 0
fi

log "building snap with snapcraft (version=$SNAP_VERSION, arch=${ARCH:-host})"

cd "$REPO_ROOT"
if [[ -n "$ARCH" ]]; then
  log "cross-build target: $ARCH"
  snapcraft --use-lxd --build-for "$ARCH" || die "snapcraft failed"
else
  snapcraft --use-lxd || snapcraft || die "snapcraft failed (tried lxd then host)"
fi

# ---------------------------------------------------------------------------
# Step 4. Move the .snap into the output directory.
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
shopt -s nullglob
for snap in "$REPO_ROOT"/*.snap; do
  mv -f "$snap" "$OUTPUT_DIR/"
  ok "wrote $OUTPUT_DIR/$(basename "$snap")"
done

# ---------------------------------------------------------------------------
# Done.
# ---------------------------------------------------------------------------
ok "build complete"
log "next: sudo snap install --dangerous $OUTPUT_DIR/${SNAP_NAME}_*.snap"

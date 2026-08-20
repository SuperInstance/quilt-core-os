#!/usr/bin/env bash
# scripts/build-image.sh — build a custom Ubuntu Core image with the
# Quilt snap pre-installed.
#
# This wraps `ubuntu-image` (the official tool for building
# Ubuntu Core images) with the Quilt gadget and model assertion.
#
# Usage:
#   ./scripts/build-image.sh pi4                # Raspberry Pi 4
#   ./scripts/build-image.sh pi5                # Raspberry Pi 5
#   ./scripts/build-image.sh jetson             # NVIDIA Jetson Orin
#   ./scripts/build-image.sh amd64              # generic x86_64
#   ./scripts/build-image.sh pi4 --channel=beta # pin to a snap channel
#   ./scripts/build-image.sh pi4 --snap=path.snap # embed a local snap
#                                                 (instead of from the store)
#   ./scripts/build-image.sh pi4 --model-key=KEY --model-crt=CRT
#                                                # sign with a real model key
#   ./scripts/build-image.sh pi4 --output=out/  # where to put the image
#
# The output is a .img.xz file that can be flashed directly to an
# SD card with `scripts/flash-pi.sh`.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths and defaults.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CHANNEL="edge"
SNAP_PATH=""
MODEL_KEY=""
MODEL_CRT=""
OUTPUT_DIR="$REPO_ROOT"
EXTRA_SNAPS=()

# ---------------------------------------------------------------------------
# Per-board definitions.
# ---------------------------------------------------------------------------
declare -A GADGETS=(
  [pi4]="gadget/pi4.yaml"
  [pi5]="gadget/pi5.yaml"
  [jetson]="gadget/jetson.yaml"
  [amd64]="gadget/amd64.yaml"
)
declare -A MODEL_ASSERTIONS=(
  [pi4]="pi4.model"
  [pi5]="pi5.model"
  [jetson]="jetson.model"
  [amd64]="amd64.model"
)
declare -A IMAGE_NAMES=(
  [pi4]="quilt-core-pi4"
  [pi5]="quilt-core-pi5"
  [jetson]="quilt-core-jetson"
  [amd64]="quilt-core-amd64"
)

# ---------------------------------------------------------------------------
# Logging.
# ---------------------------------------------------------------------------
log() { printf '\033[1;34m[build-image]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[build-image]\033[0m %s\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m[build-image]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Argument parsing.
# ---------------------------------------------------------------------------
BOARD="${1:-}"
if [[ -z "$BOARD" ]]; then
  cat <<USAGE
Usage: $0 <board> [options]

Boards:
  pi4       Raspberry Pi 4 (1/2/4/8 GB)
  pi5       Raspberry Pi 5 (4/8 GB)
  jetson    NVIDIA Jetson Orin Nano
  amd64     Generic amd64 (NUC, MiniPC, server-class)

Options:
  --channel=CHANNEL       snap channel to embed (default: edge)
  --snap=path.snap        embed a local snap (instead of pulling from the store)
  --extra-snap=name[=track]   add another snap to the model
  --model-key=keyfile     sign with a real model key (default: test key)
  --model-crt=crtfile     model signing certificate
  --output=dir            output directory (default: $REPO_ROOT)
  -h, --help              this help
USAGE
  exit 1
fi
shift

if [[ -z "${GADGETS[$BOARD]+x}" ]]; then
  die "unknown board: $BOARD (try one of: ${!GADGETS[*]})"
fi

for arg in "$@"; do
  case "$arg" in
    --channel=*)     CHANNEL="${arg#--channel=}" ;;
    --snap=*)        SNAP_PATH="${arg#--snap=}" ;;
    --extra-snap=*)  EXTRA_SNAPS+=("${arg#--extra-snap=}") ;;
    --model-key=*)   MODEL_KEY="${arg#--model-key=}" ;;
    --model-crt=*)   MODEL_CRT="${arg#--model-crt=}" ;;
    --output=*)      OUTPUT_DIR="${arg#--output=}" ;;
    -h|--help)       sed -n '2,40p' "$0"; exit 0 ;;
    *)               die "unknown argument: $arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# Tooling.
# ---------------------------------------------------------------------------
require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "missing required tool: $1"
  fi
}
require ubuntu-image
require snap

# ---------------------------------------------------------------------------
# Workdir.
# ---------------------------------------------------------------------------
WORK="$(mktemp -d -t quilt-core-image-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

log "workdir: $WORK"
log "board:   $BOARD"
log "channel: $CHANNEL"

# ---------------------------------------------------------------------------
# 1. Make sure we have a quilt-core snap to embed.
#
# If the user didn't pass --snap, we build one and pull it from the
# `snapcraft` build output. If neither works, we fall back to the
# snap store (the model assertion will request it).
# ---------------------------------------------------------------------------
GADGET_PATH="$REPO_ROOT/${GADGETS[$BOARD]}"
if [[ ! -f "$GADGET_PATH" ]]; then
  die "gadget not found: $GADGET_PATH"
fi

SNAP_TO_EMBED=""
if [[ -n "$SNAP_PATH" ]]; then
  if [[ ! -f "$SNAP_PATH" ]]; then
    die "--snap does not exist: $SNAP_PATH"
  fi
  SNAP_TO_EMBED="$SNAP_PATH"
  log "embedding local snap: $SNAP_PATH"
else
  # Try to find a recently built snap in the repo.
  CANDIDATE="$(ls -1t "$REPO_ROOT"/quilt-core_*.snap 2>/dev/null | head -n 1 || true)"
  if [[ -n "$CANDIDATE" && -f "$CANDIDATE" ]]; then
    SNAP_TO_EMBED="$CANDIDATE"
    log "embedding previously built snap: $CANDIDATE"
  else
    log "no local snap found; image will pull quilt-core from the store ($CHANNEL)"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Stage the model assertion.
#
# We sign the model either with the test key shipped in this repo
# or with the operator's production key.
# ---------------------------------------------------------------------------
KEY_DIR="$WORK/keys"
mkdir -p "$KEY_DIR"

if [[ -n "$MODEL_KEY" && -n "$MODEL_CRT" ]]; then
  if [[ ! -f "$MODEL_KEY" || ! -f "$MODEL_CRT" ]]; then
    die "--model-key/--model-crt: file not found"
  fi
  cp -f "$MODEL_KEY" "$KEY_DIR/model.key"
  cp -f "$MODEL_CRT" "$KEY_DIR/model.crt"
  log "using production model key"
else
  log "using test model key (not suitable for production)"
  cat > "$KEY_DIR/model.key" <<'KEY'
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEEIF9LR9tGHJhpXSXhwlEmG2g6Kkq3jI3YjBhYWJjZGVmGhZ6BgkqhkiG
9w0BAjEeDAlhbgNVASEMBVJldHJ5BgNVBAgTCkF1dG8tR2VuS2V5MA0GA1UEAwwG
dGVzdGtleSAtIDIwMjQK
-----END EC PRIVATE KEY-----
KEY
  cat > "$KEY_DIR/model.crt" <<'CRT'
-----BEGIN CERTIFICATE-----
MIIBazCCARygAwIBAgIUKGZ6BgkqhkiG9w0BAjEeDAlhbgNVASEMBVJldHJ5BgNV
BAgTCkF1dG8tR2VuS2V5MA0GA1UEAwwGdGVzdGtleSAtIDIwMjQK
-----END CERTIFICATE-----
CRT
fi

# Build the model assertion. We patch the snap-channel field to
# match the user's request, and append any extra snaps.
MODEL_TMPL="$REPO_ROOT/${MODEL_ASSERTIONS[$BOARD]}"
if [[ ! -f "$MODEL_TMPL" ]]; then
  die "model template not found: $MODEL_TMPL"
fi

MODEL_FILE="$WORK/model.assert"
cp -f "$MODEL_TMPL" "$MODEL_FILE"

# Channel substitution. We do this with sed because the assertion
# is a fixed text format and templating it in bash is fine.
sed -i "s/channel: .*/channel: $CHANNEL/" "$MODEL_FILE"
log "model: $MODEL_FILE"

# ---------------------------------------------------------------------------
# 3. Build the image.
#
# `ubuntu-image snap` builds an image for a Core-style system. We
# pass the gadget, the model, and any extra snaps via --snap.
# ---------------------------------------------------------------------------
ARGS=(
  snap
  --workdir "$WORK/build"
  -O "$OUTPUT_DIR"
  "$MODEL_FILE"
  --gadget "$GADGET_PATH"
)
if [[ -n "$SNAP_TO_EMBED" ]]; then
  ARGS+=(--snap "$SNAP_TO_EMBED")
fi
for s in "${EXTRA_SNAPS[@]}"; do
  ARGS+=(--extra-snap "$s")
done

log "running: ubuntu-image ${ARGS[*]}"
ubuntu-image "${ARGS[@]}" || die "ubuntu-image failed"

# ---------------------------------------------------------------------------
# 4. Move the image to the requested output dir.
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
BUILT="$(ls -1t "$WORK/build"/*.img 2>/dev/null | head -n 1 || true)"
if [[ -z "$BUILT" || ! -f "$BUILT" ]]; then
  die "ubuntu-image produced no .img file"
fi

BASE_NAME="${IMAGE_NAMES[$BOARD]}"
xz -9 -T 0 -c "$BUILT" > "$OUTPUT_DIR/${BASE_NAME}.img.xz"
rm -f "$BUILT"

ok "wrote $OUTPUT_DIR/${BASE_NAME}.img.xz"
ok "build complete"

log "next: ./scripts/flash-pi.sh $OUTPUT_DIR/${BASE_NAME}.img.xz /dev/sdX"

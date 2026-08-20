#!/usr/bin/env bash
# scripts/flash-pi.sh — flash a quilt-core image to an SD card or
# block device.
#
# This is a thin wrapper around `bmaptool` and `xz` that adds
# confirmation prompts and a sanity check. The actual flash is
# bmap-based, which is much faster than dd on large SD cards
# (writes only the used blocks).
#
# Usage:
#   sudo ./scripts/flash-pi.sh out/quilt-core-pi4.img.xz /dev/sdX
#   sudo ./scripts/flash-pi.sh out/quilt-core-pi4.img.xz /dev/mmcblk0
#
# WARNING: this will overwrite the destination device without
# asking for confirmation unless --yes is passed. Triple-check the
# device path before running.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths and defaults.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

YES=0
VERBOSE=0
BANDWIDTH_MB=""
BS=16M

# ---------------------------------------------------------------------------
# Logging.
# ---------------------------------------------------------------------------
log() { printf '\033[1;34m[flash-pi]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[flash-pi]\033[0m %s\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m[flash-pi]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Argument parsing.
# ---------------------------------------------------------------------------
if [[ $# -lt 2 ]]; then
  cat <<USAGE
Usage: sudo $0 <image> <device> [options]

Arguments:
  <image>     Path to a .img or .img.xz file. For .img.xz we decompress on the fly.
  <device>    Target block device, e.g. /dev/sdX, /dev/mmcblk0.

Options:
  --yes                  skip the confirmation prompt
  --verbose              show bmaptool output
  --bandwidth-mb=N       throttle bmaptool to N MB/s (good for slow USB readers)
  --bs=SIZE              dd block size (default: $BS)
  -h, --help             this help
USAGE
  exit 1
fi

IMG="$1"
DEV="$2"
shift 2

for arg in "$@"; do
  case "$arg" in
    --yes)              YES=1 ;;
    --verbose)          VERBOSE=1 ;;
    --bandwidth-mb=*)   BANDWIDTH_MB="${arg#--bandwidth-mb=}" ;;
    --bs=*)             BS="${arg#--bs=}" ;;
    -h|--help)          sed -n '2,20p' "$0"; exit 0 ;;
    *)                  die "unknown argument: $arg" ;;
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

# Either bmaptool (preferred) or dd.
HAVE_BMAP=0
if command -v bmaptool >/dev/null 2>&1; then
  HAVE_BMAP=1
else
  require dd
  require xz
fi

require lsblk
require findmnt
require sync
require umount

# ---------------------------------------------------------------------------
# 1. Validate the image file.
# ---------------------------------------------------------------------------
if [[ ! -f "$IMG" ]]; then
  die "image not found: $IMG"
fi

IMG_TYPE="$(file -b "$IMG" 2>/dev/null || echo unknown)"
log "image: $IMG ($IMG_TYPE)"
if [[ "$IMG_TYPE" == *"XZ compressed data"* ]]; then
  log "image is xz-compressed; will decompress on the fly"
fi

# ---------------------------------------------------------------------------
# 2. Validate the destination device.
# ---------------------------------------------------------------------------
if [[ ! -b "$DEV" ]]; then
  die "not a block device: $DEV"
fi

# Refuse if the device is mounted.
if findmnt -S "$DEV" >/dev/null 2>&1 || findmnt -S "${DEV}p1" >/dev/null 2>&1; then
  die "device $DEV has mounted partitions; unmount them first"
fi

# Detect size.
DEV_SIZE="$(lsblk -b -d -n -o SIZE "$DEV" 2>/dev/null | tr -d ' ' || echo 0)"
DEV_MODEL="$(lsblk -d -n -o MODEL "$DEV" 2>/dev/null | sed 's/^ *//' || true)"

log "target: $DEV ($DEV_MODEL, ${DEV_SIZE} bytes)"

# Sanity check: the device must be larger than 4 GB (Pi images are 4+ GB).
if [[ "${DEV_SIZE:-0}" -lt 4000000000 ]]; then
  die "device $DEV is too small (< 4 GB); double-check the path"
fi

# ---------------------------------------------------------------------------
# 3. Confirm.
# ---------------------------------------------------------------------------
if [[ $YES -ne 1 ]]; then
  cat <<WARN

  ╔══════════════════════════════════════════════════════════════╗
  ║  WARNING: about to overwrite $DEV
  ║  model: ${DEV_MODEL:-unknown}
  ║  size:  $((DEV_SIZE / 1024 / 1024 / 1024)) GB
  ╚══════════════════════════════════════════════════════════════╝

WARN
  read -r -p "type 'yes' to continue: " ans
  if [[ "$ans" != "yes" ]]; then
    die "aborted"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Flash.
# ---------------------------------------------------------------------------
if [[ $HAVE_BMAP -eq 1 ]]; then
  log "flashing via bmaptool"
  BMAP_ARGS=()
  [[ $VERBOSE -eq 1 ]] && BMAP_ARGS+=(--verbose)
  [[ -n "$BANDWIDTH_MB" ]] && BMAP_ARGS+=(--bandwidth "${BANDWIDTH_MB}M")
  # If the image is xz-compressed, decompress to a fifo so bmaptool
  # can stream it.
  if [[ "$IMG_TYPE" == *"XZ compressed data"* ]]; then
    FIFO="$(mktemp -u)"
    rm -f "$FIFO"; mkfifo "$FIFO"
    (xz -dc "$IMG" > "$FIFO") &
    DECOMP_PID=$!
    set +e
    bmaptool copy "${BMAP_ARGS[@]}" --bmap "${IMG%.xz}.bmap" "$FIFO" "$DEV"
    RC=$?
    set -e
    rm -f "$FIFO"
    wait "$DECOMP_PID" 2>/dev/null || true
    [[ $RC -eq 0 ]] || die "bmaptool failed (rc=$RC)"
  else
    bmaptool copy "${BMAP_ARGS[@]}" "$IMG" "$DEV" || die "bmaptool failed"
  fi
else
  log "flashing via dd (slower; decompressing to a temp file first)"
  TMP_IMG="$(mktemp -t quilt-core-img-XXXXXX.img)"
  trap 'rm -f "$TMP_IMG"' EXIT
  if [[ "$IMG_TYPE" == *"XZ compressed data"* ]]; then
    xz -dc "$IMG" > "$TMP_IMG"
  else
    cp -f "$IMG" "$TMP_IMG"
  fi
  dd if="$TMP_IMG" of="$DEV" bs="$BS" status=progress conv=fsync || die "dd failed"
  sync
  rm -f "$TMP_IMG"
fi

# ---------------------------------------------------------------------------
# 5. Sync and report.
# ---------------------------------------------------------------------------
sync
ok "flash complete"

# Print the UUIDs of the partitions we just wrote, so the user can
# pick the right boot partition for a headless setup.
lsblk -o NAME,SIZE,TYPE,LABEL,UUID "$DEV" >&2 || true

log "next steps:"
log "  1.  insert the SD card into the Pi and power it on"
log "  2.  wait ~90s for first boot to complete (Ubuntu Core is slow on first boot)"
log "  3.  ssh ubuntu@<pi-ip>  (password is set via the Ubuntu SSO dashboard)"
log "  4.  quilt-core init   to register this node with quilt-fleet"
log "  5.  quilt-core status to verify"

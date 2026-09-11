#!/usr/bin/env bash
#
# unpack-dav.sh - unpack a Hikvision / EZVIZ firmware image (*.dav)
#
# Pipeline
#   1. hikpack -t <type> -x <firmware.dav> -o <outdir>   strip the outer .dav container
#   2. unsquashfs -d <outdir>/rootfs <outdir>/app.img    unpack the SquashFS root filesystem
#
# hikpack is a Linux x86-64 ELF and will not run natively on macOS, so this script
# detects the platform and falls back to Docker (--platform linux/amd64) whenever
# the host is macOS, or is Linux on a CPU that is not x86-64.
#
# Usage
#   ./unpack-dav.sh [options] <firmware.dav>
#
# Options
#   -t <type>   hikpack platform type (r0 r1 r6 g0 k41 k51)   [default: r0]
#   -o <dir>    output directory                              [default: <davdir>/unpacked]
#   -p <path>   path to the hikpack binary                    [default: beside this script]
#   -n          never use Docker (fail instead of containerising)
#   -h          show this help
#
# Environment
#   HIKPACK           path to hikpack (same as -p)
#   HIK_IMAGE         docker image used to run hikpack   [default: debian:bullseye-slim]
#   SQFS_IMAGE        docker image used for squashfs     [default: debian:bookworm-slim]
#   DOCKER_PLATFORM   docker --platform value            [default: linux/amd64]
#
# Note: the containerised squashfs step apt-installs squashfs-tools on first use,
# so it needs network access once per fresh image.

set -euo pipefail

# --------------------------------------------------------------- locations
#
# The script is designed to be self-contained: drop hikpack in the same folder
# as unpack-dav.sh and it will be found automatically.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# ---------------------------------------------------------------- defaults

FW_TYPE="r0"
OUT_DIR=""
HIKPACK="${HIKPACK:-}"
FORCE_NO_DOCKER=0

HIK_IMAGE="${HIK_IMAGE:-debian:bullseye-slim}"
SQFS_IMAGE="${SQFS_IMAGE:-debian:bookworm-slim}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

# ---------------------------------------------------------------- messages

log()  { printf '==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

# ------------------------------------------------------------ arg parsing

while getopts ':t:o:p:nh' opt; do
    case "$opt" in
        t) FW_TYPE=$OPTARG ;;
        o) OUT_DIR=$OPTARG ;;
        p) HIKPACK=$OPTARG ;;
        n) FORCE_NO_DOCKER=1 ;;
        h) usage 0 ;;
        :) die "option -$OPTARG requires an argument" ;;
        *) usage 1 ;;
    esac
done
shift $((OPTIND - 1))

[ $# -ge 1 ] || { usage 1; }
[ $# -eq 1 ] || die "expected exactly one firmware file, got $#"

DAV=$1
[ -f "$DAV" ] || die "no such file: $DAV"

case "$FW_TYPE" in
    r0|r1|r6|g0|k41|k51) ;;
    *) die "unsupported firmware type '$FW_TYPE' (expected r0 r1 r6 g0 k41 k51)" ;;
esac

# ------------------------------------------------------- resolve the paths

DAV_DIR=$(cd "$(dirname "$DAV")" && pwd)
DAV_BASE=$(basename "$DAV")

[ -n "$OUT_DIR" ] || OUT_DIR="$DAV_DIR/unpacked"
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)

# -------------------------------------------------------- find hikpack

if [ -z "$HIKPACK" ]; then
    for cand in "$SCRIPT_DIR/hikpack" "$DAV_DIR/hikpack"; do
        [ -f "$cand" ] && HIKPACK=$cand && break
    done
fi
[ -n "$HIKPACK" ] || HIKPACK=$(command -v hikpack 2>/dev/null || true)
[ -n "$HIKPACK" ] || die "hikpack not found - copy it beside this script ($SCRIPT_DIR), or pass -p <path>"
[ -f "$HIKPACK" ] || die "hikpack is not a file: $HIKPACK"
HIKPACK=$(cd "$(dirname "$HIKPACK")" && pwd)/$(basename "$HIKPACK")

# ---------------------------------------------------- decide the executor
#
# Use Docker when the host cannot execute hikpack directly. That means macOS
# always, Linux on a non-x86-64 CPU, and Linux where the binary fails to exec
# (wrong libc, missing loader, ...).

USE_DOCKER=0
declare -r OS_NAME=$(uname -s)
ARCH=$(uname -m)

if [ "$FORCE_NO_DOCKER" = 1 ]; then
    USE_DOCKER=0
elif [ "$OS_NAME" = "Darwin" ]; then
    USE_DOCKER=1
elif [ "$OS_NAME" = "Linux" ]; then
    case "$ARCH" in
        x86_64|amd64) USE_DOCKER=0 ;;
        *) USE_DOCKER=1 ;;
    esac
else
    USE_DOCKER=1
fi

# Even on x86-64 Linux the ELF may not exec - probe it and fall back.
if [ "$USE_DOCKER" = 0 ]; then
    probe=$("$HIKPACK" 2>&1 || true)
    # Match hikpack's own banner. Do not match on the path: an "exec format
    # error" message contains the binary's name and would look like success.
    case "$probe" in
        *"Usage:"*) : ;;
        *)
            if [ "$FORCE_NO_DOCKER" = 1 ]; then
                die "hikpack does not execute on this host ($OS_NAME/$ARCH), and -n forbids Docker"
            fi
            warn "hikpack does not execute here; falling back to Docker"
            USE_DOCKER=1
            ;;
    esac
fi

if [ "$USE_DOCKER" = 1 ]; then
    command -v docker >/dev/null 2>&1 \
        || die "Docker is required on $OS_NAME/$ARCH but 'docker' is not on PATH"
    docker info >/dev/null 2>&1 \
        || die "Docker is installed but the daemon is not reachable"
fi

# -------------------------------------------------------------- reporting

log "firmware    $DAV_BASE"
log "type        $FW_TYPE"
log "output      $OUT_DIR"
log "hikpack     $HIKPACK"
if [ "$USE_DOCKER" = 1 ]; then
    log "executor    docker ($DOCKER_PLATFORM) - host is $OS_NAME/$ARCH"
else
    log "executor    native ($OS_NAME/$ARCH)"
fi

# ------------------------------------------------- step 1: hikpack -x

log "stripping .dav container"

if [ "$USE_DOCKER" = 1 ]; then
    docker run --rm --platform "$DOCKER_PLATFORM" \
        -v "$HIKPACK:/hikpack:ro" \
        -v "$DAV_DIR:/src:ro" \
        -v "$OUT_DIR:/out" \
        "$HIK_IMAGE" /hikpack -t "$FW_TYPE" -x "/src/$DAV_BASE" -o /out
else
    "$HIKPACK" -t "$FW_TYPE" -x "$DAV" -o "$OUT_DIR"
fi

# ------------------------------------------------- find the squashfs image
#
# SquashFS magic is "hsqs" (0x73717368 little-endian) in the first 4 bytes.

find_squashfs() {
    local f magic
    for f in "$1"/*; do
        [ -f "$f" ] || continue
        case "$f" in *.part) continue ;; esac
        magic=$(dd if="$f" bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')
        if [ "$magic" = "68737173" ]; then
            printf '%s\n' "$f"
            return 0
        fi
    done
    return 1
}

SQFS=$(find_squashfs "$OUT_DIR" || true)

if [ -z "$SQFS" ]; then
    warn "no SquashFS image among the extracted files - stopping after step 1"
    log "extracted:"
    ls -la "$OUT_DIR" >&2
    exit 0
fi

SQFS_BASE=$(basename "$SQFS")
log "root filesystem   $SQFS_BASE"

# --------------------------------------------- step 2: unsquashfs rootfs

ROOTFS="$OUT_DIR/rootfs"
[ -e "$ROOTFS" ] && die "$ROOTFS already exists - remove it first"
log "unpacking SquashFS"

if [ "$USE_DOCKER" = 1 ]; then
    docker run --rm --platform "$DOCKER_PLATFORM" \
        -v "$OUT_DIR:/out" -w /out "$SQFS_IMAGE" \
        sh -c 'apt-get update -qq >/dev/null 2>&1
               apt-get install -y -qq squashfs-tools >/dev/null 2>&1
               unsquashfs -d /out/rootfs "/out/$1"' _ "$SQFS_BASE"
else
    command -v unsquashfs >/dev/null 2>&1 \
        || die "unsquashfs not found - install squashfs-tools"
    unsquashfs -d "$ROOTFS" "$SQFS"
fi

# ------------------------------------------------------------- summary

log "done"
printf '\n' >&2
printf 'container:  %s\n' "$OUT_DIR" >&2
find "$OUT_DIR" -maxdepth 1 -type f -exec ls -la {} + 2>/dev/null \
    | awk '{printf "  %10s  %s\n", $5, $9}' >&2
printf 'rootfs:     %s (%s entries)\n' "$ROOTFS" "$(ls -A "$ROOTFS" 2>/dev/null | wc -l | tr -d ' ')" >&2

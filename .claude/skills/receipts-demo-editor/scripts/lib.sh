#!/usr/bin/env bash
# Shared helpers for receipts-demo-editor scripts. Source, don't execute.

set -euo pipefail

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "required tool '$1' not found in PATH"
}

# Refuse to write anywhere that is not inside a directory named "output" (or a
# descendant of one), so a bad argument can never clobber source recordings.
# Textual check only — the target directory may not exist yet.
assert_output_path() {
  local p=$1 abs
  case "$p" in /*) abs=$p ;; *) abs=$PWD/$p ;; esac
  case "/$abs" in
    */output/*) ;;
    *) die "refusing to write outside an output/ directory: $abs" ;;
  esac
}

# Target render settings; PREVIEW=1 switches to a fast low-res draft.
render_settings() {
  if [[ "${PREVIEW:-0}" == "1" ]]; then
    W=640; H=360; FPS=30; CRF=30; PRESET=ultrafast; ABR=96k
  else
    W=1920; H=1080; FPS=30; CRF=18; PRESET=medium; ABR=192k
  fi
  VF_NORM="scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x101014,setsar=1,fps=${FPS},format=yuv420p"
  VCODEC=(-c:v libx264 -preset "$PRESET" -crf "$CRF" -profile:v high -pix_fmt yuv420p)
  ACODEC=(-c:a aac -b:a "$ABR" -ar 48000 -ac 2)
}

# Resumable rendering: skip when the output already exists, is non-empty, and
# FORCE is not set. Prints a notice so logs show what was reused.
skip_if_done() {
  local out=$1
  if [[ "${FORCE:-0}" != "1" && -s "$out" ]]; then
    printf 'SKIP (exists): %s\n' "$out"
    return 0
  fi
  return 1
}

media_duration() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 -- "$1"
}

#!/usr/bin/env bash
# Detect silence intervals in a clip's audio. Prints TSV: start<TAB>end<TAB>duration.
# usage: detect-silence.sh <media-file> [noise_dB] [min_silence_s]
#   noise_dB       silence threshold, default -35  (pass as e.g. -30)
#   min_silence_s  minimum silence length to report, default 0.6

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
[[ "${1:-}" == "--help" || "${1:-}" == "-h" || $# -lt 1 ]] && { usage; exit "${1:+0}"; }

need ffmpeg
FILE=$1; NOISE=${2:--35}; MIN=${3:-0.6}
[[ -f "$FILE" ]] || die "file not found: $FILE"

ffmpeg -hide_banner -nostats -i "$FILE" \
  -af "silencedetect=noise=${NOISE}dB:d=${MIN}" -f null - 2>&1 |
awk '
  /silence_start:/ { start = $NF }
  /silence_end:/   { printf "%s\t%s\t%s\n", start, $5, $NF }
'

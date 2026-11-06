#!/usr/bin/env bash
# Concatenate rendered segments (lexicographic order: name them 01-, 02-, ...) into the
# final video. Video is stream-copied (no generation loss); audio gets two-pass EBU R128
# loudness normalization (-16 LUFS, -1.5 dBTP). Optional ducked background music.
# usage: assemble.sh <segments-dir> <final-output.mp4> [--music FILE] [--music-gain dB]
#   --music FILE     licensed background track, mixed ~18 dB under speech
#   --music-gain dB  override music level (default -18)

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
[[ "${1:-}" == "--help" || "${1:-}" == "-h" || $# -lt 2 ]] && { usage; exit "${1:+0}"; }

need ffmpeg; need ffprobe; need jq
SEG_DIR=$1; FINAL=$2; shift 2
MUSIC="" MGAIN=-18
while [[ $# -gt 0 ]]; do
  case "$1" in
    --music) MUSIC=$2; shift 2 ;;
    --music-gain) MGAIN=$2; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -d "$SEG_DIR" ]] || die "segments directory not found: $SEG_DIR"
assert_output_path "$FINAL"
mkdir -p "$(dirname "$FINAL")"

LIST=$(mktemp -t demoedit-list)
RAW=$(mktemp -t demoedit-raw).mp4
trap 'rm -f "$LIST" "$RAW"' EXIT

# Concat with -c copy silently corrupts the result if segments differ in codec
# parameters, so verify uniformity first and name the offender.
n=0; sig=""
while IFS= read -r -d '' seg; do
  # sed strips ffprobe's occasional trailing empty CSV field
  s=$(ffprobe -v error -select_streams v:0 \
      -show_entries "stream=codec_name,width,height,pix_fmt,avg_frame_rate" \
      -of csv=p=0 -- "$seg" | sed 's/,*$//')
  a=$(ffprobe -v error -select_streams a:0 \
      -show_entries "stream=codec_name,sample_rate,channels" -of csv=p=0 -- "$seg" | sed 's/,*$//')
  [[ -n "$a" ]] || die "segment has no audio stream (concat would desync): $seg"
  if [[ -z "$sig" ]]; then sig="$s|$a"
  elif [[ "$s|$a" != "$sig" ]]; then
    die "segment parameters differ from the first segment ($sig vs $s|$a): $seg — re-render it with render-segment.sh"
  fi
  printf "file '%s'\n" "${seg//\'/\'\\\'\'}" >> "$LIST"
  n=$((n + 1))
done < <(find "$SEG_DIR" -maxdepth 1 -name '*.mp4' -print0 | sort -z)
[[ $n -gt 0 ]] || die "no .mp4 segments found in $SEG_DIR"
echo "Concatenating $n segments..."

ffmpeg -y -v error -f concat -safe 0 -i "$LIST" -c copy "$RAW"

echo "Measuring loudness (pass 1/2)..."
stats=$(ffmpeg -hide_banner -nostats -i "$RAW" -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 |
        sed -n '/^{/,/^}/p')
[[ -n "$stats" ]] || die "loudnorm measurement failed"
II=$(jq -r .input_i <<<"$stats"); IT=$(jq -r .input_tp <<<"$stats")
IL=$(jq -r .input_lra <<<"$stats"); ITH=$(jq -r .input_thresh <<<"$stats")
OFF=$(jq -r .target_offset <<<"$stats")
echo "  measured: I=${II} LUFS, TP=${IT} dBTP, LRA=${IL}"

LN="loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${II}:measured_TP=${IT}:measured_LRA=${IL}:measured_thresh=${ITH}:offset=${OFF}:linear=true"

echo "Normalizing (pass 2/2) and writing final..."
if [[ -n "$MUSIC" ]]; then
  [[ -f "$MUSIC" ]] || die "music file not found: $MUSIC"
  ffmpeg -y -v error -i "$RAW" -stream_loop -1 -i "$MUSIC" \
    -filter_complex "[0:a]${LN}[speech];[1:a]volume=${MGAIN}dB,aresample=48000[bgm];[speech][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.89[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 \
    -movflags +faststart "$FINAL"
else
  ffmpeg -y -v error -i "$RAW" -af "$LN" \
    -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 \
    -movflags +faststart "$FINAL"
fi

DUR=$(media_duration "$FINAL")
printf 'Final: %s  (%.1f s, %d segments)\n' "$FINAL" "$DUR" "$n"
printf 'Loudnorm measured input: I=%s LUFS, TP=%s dBTP, LRA=%s (target -16/-1.5/11)\n' "$II" "$IT" "$IL"

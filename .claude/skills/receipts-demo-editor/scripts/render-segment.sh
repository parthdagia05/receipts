#!/usr/bin/env bash
# Render one scene of the edit plan into a normalized segment (same codec, size,
# fps and audio layout for every segment, so assembly can concat losslessly).
#
# usage: render-segment.sh --mode MODE --out FILE [options]
# modes:
#   facecam  presenter full-screen        --src F --in T --to T
#   screen   screen recording full-screen --video F [--vin T] --audio F --ain T --ato T
#   pip      screen large + facecam inset --video F [--vin T] --pip F [--pin T] --audio F --ain T --ato T
#   still    image full-screen            --image F --audio F --ain T --ato T [--kenburns]
#   title    delegated to make-title-card.sh (same arguments)
#
# The narration audio track (--audio, usually the facecam clip) defines the scene
# duration in screen/pip/still modes. If the visual runs short, its last frame holds.
# env: PREVIEW=1 renders 640x360 draft; FORCE=1 re-renders an existing segment.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

MODE="" OUT="" SRC="" IN="" TO="" VIDEO="" VIN=0 PIPSRC="" PIN=0
AUDIO="" AIN="" ATO="" IMAGE="" KENBURNS=0
TITLE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --src) SRC=$2; shift 2 ;;
    --in) IN=$2; shift 2 ;;
    --to) TO=$2; shift 2 ;;
    --video) VIDEO=$2; shift 2 ;;
    --vin) VIN=$2; shift 2 ;;
    --pip) PIPSRC=$2; shift 2 ;;
    --pin) PIN=$2; shift 2 ;;
    --audio) AUDIO=$2; shift 2 ;;
    --ain) AIN=$2; shift 2 ;;
    --ato) ATO=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    --kenburns) KENBURNS=1; shift ;;
    --title|--subtitle|--duration|--bg|--fg|--accent) TITLE_ARGS+=("$1" "$2"); shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$MODE" && -n "$OUT" ]] || { usage; exit 1; }

if [[ "$MODE" == "title" ]]; then
  exec "$SCRIPT_DIR/make-title-card.sh" --out "$OUT" "${TITLE_ARGS[@]}"
fi

need ffmpeg
assert_output_path "$OUT"
mkdir -p "$(dirname "$OUT")"
skip_if_done "$OUT" && exit 0
render_settings

AF_NORM="aresample=48000"

case "$MODE" in
  facecam)
    [[ -f "$SRC" && -n "$IN" && -n "$TO" ]] || die "facecam mode needs --src --in --to"
    ffmpeg -y -v error -ss "$IN" -to "$TO" -i "$SRC" \
      -vf "$VF_NORM" -af "$AF_NORM" "${VCODEC[@]}" "${ACODEC[@]}" "$OUT"
    ;;
  screen)
    [[ -f "$VIDEO" && -f "$AUDIO" && -n "$AIN" && -n "$ATO" ]] || die "screen mode needs --video --audio --ain --ato"
    DUR=$(echo "$ATO - $AIN" | bc)
    ffmpeg -y -v error \
      -ss "$AIN" -to "$ATO" -i "$AUDIO" \
      -ss "$VIN" -i "$VIDEO" \
      -filter_complex "[1:v]${VF_NORM},tpad=stop_mode=clone:stop_duration=3600[v];[0:a]${AF_NORM}[a]" \
      -map "[v]" -map "[a]" -t "$DUR" "${VCODEC[@]}" "${ACODEC[@]}" "$OUT"
    ;;
  pip)
    [[ -f "$VIDEO" && -f "$PIPSRC" && -f "$AUDIO" && -n "$AIN" && -n "$ATO" ]] || \
      die "pip mode needs --video --pip --audio --ain --ato"
    DUR=$(echo "$ATO - $AIN" | bc)
    PW=$(( (W * 22 / 100) / 2 * 2 ))   # inset ~22% of frame width, even number
    M=$((W / 45))
    ffmpeg -y -v error \
      -ss "$AIN" -to "$ATO" -i "$AUDIO" \
      -ss "$VIN" -i "$VIDEO" \
      -ss "$PIN" -i "$PIPSRC" \
      -filter_complex "\
[1:v]${VF_NORM},tpad=stop_mode=clone:stop_duration=3600[main];\
[2:v]scale=${PW}:-2,fps=${FPS},format=yuv420p,pad=iw+6:ih+6:3:3:color=0xffffff@0.9[inset];\
[main][inset]overlay=W-w-${M}:H-h-${M}[v];\
[0:a]${AF_NORM}[a]" \
      -map "[v]" -map "[a]" -t "$DUR" "${VCODEC[@]}" "${ACODEC[@]}" "$OUT"
    ;;
  still)
    [[ -f "$IMAGE" && -f "$AUDIO" && -n "$AIN" && -n "$ATO" ]] || die "still mode needs --image --audio --ain --ato"
    DUR=$(echo "$ATO - $AIN" | bc)
    if [[ "$KENBURNS" == "1" ]]; then
      FRAMES=$(echo "$DUR * $FPS" | bc | cut -d. -f1)
      VF="scale=8000:-1,zoompan=z='min(zoom+0.0006,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${FRAMES}:s=${W}x${H}:fps=${FPS},format=yuv420p"
    else
      VF="$VF_NORM"
    fi
    ffmpeg -y -v error \
      -ss "$AIN" -to "$ATO" -i "$AUDIO" \
      -loop 1 -i "$IMAGE" \
      -filter_complex "[1:v]${VF}[v];[0:a]${AF_NORM}[a]" \
      -map "[v]" -map "[a]" -t "$DUR" "${VCODEC[@]}" "${ACODEC[@]}" "$OUT"
    ;;
  *) die "unknown mode: $MODE (facecam|screen|pip|still|title)" ;;
esac
echo "Segment: $OUT"

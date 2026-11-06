#!/usr/bin/env bash
# Render a title-card segment (video + silent audio) with fade in/out.
# usage: make-title-card.sh --out FILE --title TEXT [--subtitle TEXT] [--duration S]
#                           [--bg HEX] [--fg HEX] [--accent HEX]
# defaults: duration 3.0, bg 0x101014, fg 0xffffff, accent 0x7c8cf8
# Uses ffmpeg drawtext when the build has it; otherwise renders the card as a PNG
# via AppKit (macOS osascript) and animates that.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

OUT="" TITLE="" SUBTITLE="" DUR=3.0 BG=0x101014 FG=0xffffff ACCENT=0x7c8cf8
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT=$2; shift 2 ;;
    --title) TITLE=$2; shift 2 ;;
    --subtitle) SUBTITLE=$2; shift 2 ;;
    --duration) DUR=$2; shift 2 ;;
    --bg) BG=$2; shift 2 ;;
    --fg) FG=$2; shift 2 ;;
    --accent) ACCENT=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$OUT" && -n "$TITLE" ]] || { usage; exit 1; }

need ffmpeg
assert_output_path "$OUT"
mkdir -p "$(dirname "$OUT")"
skip_if_done "$OUT" && exit 0
render_settings

FADE=0.4
FOUT=$(echo "$DUR - $FADE" | bc)
FADES="fade=t=in:st=0:d=${FADE},fade=t=out:st=${FOUT}:d=${FADE},format=yuv420p"

if ffmpeg -hide_banner -filters 2>/dev/null | grep -q drawtext; then
  esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\\\\\\\\\''/g" -e 's/:/\\:/g'; }
  T=$(esc "$TITLE"); S=$(esc "$SUBTITLE")
  FONT="/System/Library/Fonts/Helvetica.ttc"
  [[ -f "$FONT" ]] || FONT=$(fc-match -f '%{file}' sans 2>/dev/null || true)
  [[ -f "$FONT" ]] || die "no usable font found for drawtext"
  TS=$((H / 9)); SS=$((H / 24))
  vf="drawtext=fontfile=${FONT}:text='${T}':fontcolor=${FG}:fontsize=${TS}:x=(w-text_w)/2:y=(h-text_h)/2-${SS}"
  vf+=",drawbox=x=(iw-iw/6)/2:y=(ih/2)+${SS}:w=iw/6:h=4:color=${ACCENT}:t=fill"
  [[ -n "$SUBTITLE" ]] && vf+=",drawtext=fontfile=${FONT}:text='${S}':fontcolor=${FG}@0.75:fontsize=${SS}:x=(w-text_w)/2:y=(h/2)+$((SS * 2))"
  ffmpeg -y -v error \
    -f lavfi -i "color=c=${BG}:s=${W}x${H}:r=${FPS}:d=${DUR}" \
    -f lavfi -i "anullsrc=r=48000:cl=stereo" \
    -filter_complex "[0:v]${vf},${FADES}[v]" \
    -map "[v]" -map 1:a -t "$DUR" "${VCODEC[@]}" "${ACODEC[@]}" -shortest "$OUT"
elif command -v osascript >/dev/null 2>&1; then
  png="${OUT%.mp4}.png"
  assert_output_path "$png"
  osascript -l JavaScript "$SCRIPT_DIR/render-title-png.jxa" \
    "$png" "$TITLE" "${SUBTITLE:--}" "$W" "$H" "$BG" "$FG" "$ACCENT" >/dev/null
  [[ -s "$png" ]] || die "title PNG rendering failed"
  ffmpeg -y -v error \
    -loop 1 -i "$png" \
    -f lavfi -i "anullsrc=r=48000:cl=stereo" \
    -filter_complex "[0:v]scale=${W}:${H},fps=${FPS},${FADES}[v]" \
    -map "[v]" -map 1:a -t "$DUR" "${VCODEC[@]}" "${ACODEC[@]}" "$OUT"
  rm -f "$png"
else
  die "this ffmpeg build lacks drawtext and no osascript fallback is available; reinstall ffmpeg with drawtext support"
fi
echo "Title card: $OUT"

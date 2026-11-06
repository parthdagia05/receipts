#!/usr/bin/env bash
# Walk an input folder, probe every media file, write <outdir>/media-inventory.json.
# usage: probe-media.sh <input-dir> <output-dir> [--verify]
#   --verify  also fully decode each video to confirm integrity (slow)

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
[[ "${1:-}" == "--help" || "${1:-}" == "-h" || $# -lt 2 ]] && { usage; exit "${1:+0}"; }

need ffprobe; need jq
IN_DIR=$1; OUT_DIR=$2; VERIFY=${3:-}
[[ -d "$IN_DIR" ]] || die "input directory not found: $IN_DIR"
mkdir -p "$OUT_DIR"
OUT_JSON="$OUT_DIR/media-inventory.json"
assert_output_path "$OUT_JSON"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '[]' > "$tmp"

kind_of() {
  case "${1##*.}" in
    mp4|mov|mkv|webm|m4v|avi|MP4|MOV|MKV|WEBM|M4V|AVI) echo video ;;
    png|jpg|jpeg|gif|webp|PNG|JPG|JPEG|GIF|WEBP) echo image ;;
    mp3|wav|m4a|aac|flac|ogg|MP3|WAV|M4A|AAC|FLAC|OGG) echo audio ;;
    *) echo skip ;;
  esac
}

count=0
while IFS= read -r -d '' f; do
  case "$f" in "$OUT_DIR"/*) continue ;; */output/*) continue ;; esac
  kind=$(kind_of "$f")
  [[ "$kind" == "skip" ]] && continue
  count=$((count + 1))

  if probe=$(ffprobe -v error -print_format json -show_format -show_streams -- "$f" 2>/dev/null); then
    ok=true
    if [[ "$VERIFY" == "--verify" && "$kind" == "video" ]]; then
      ffmpeg -v error -xerror -i "$f" -f null - >/dev/null 2>&1 || ok=false
    fi
  else
    probe='{}'; ok=false
  fi

  entry=$(jq -n \
    --arg path "$f" --arg kind "$kind" --argjson probe "$probe" --argjson ok "$ok" '
    ($probe.streams // [] | map(select(.codec_type=="video")) | .[0] // {}) as $v |
    ($probe.streams // [] | map(select(.codec_type=="audio")) | .[0] // {}) as $a |
    { path: $path, kind: $kind, ok: $ok,
      duration: (($probe.format.duration // "0") | tonumber),
      size_bytes: (($probe.format.size // "0") | tonumber),
      video: (if $v == {} then null else {
        codec: $v.codec_name, width: $v.width, height: $v.height,
        fps: ($v.avg_frame_rate // "0/1"),
        rotation: (($v.side_data_list // []) | map(.rotation // empty) | .[0] // 0),
        pix_fmt: $v.pix_fmt } end),
      audio: (if $a == {} then null else {
        codec: $a.codec_name, channels: $a.channels,
        sample_rate: ($a.sample_rate // "0" | tonumber) } end) }')
  jq --argjson e "$entry" '. + [$e]' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp"
done < <(find "$IN_DIR" -type f -print0 | sort -z)

jq -n --arg root "$IN_DIR" --argjson files "$(cat "$tmp")" \
  '{ root: $root, probed_at: (now | todate), files: $files }' > "$OUT_JSON"

printf 'Probed %d media files -> %s\n' "$count" "$OUT_JSON"
jq -r '.files[] | select(.ok == false) | "CORRUPT/UNREADABLE: " + .path' "$OUT_JSON"

#!/usr/bin/env bash
# Transcribe a clip with whisper-cpp. Writes <outdir>/<clipname>.json (word timestamps)
# and <clipname>.srt. The outdir must be inside an output/ directory.
# usage: transcribe.sh <media-file> <outdir>
#        transcribe.sh --download-model     # fetch ggml-base.en.bin (~142 MB) to ~/.cache/whisper-cpp/
# env:   WHISPER_MODEL=/path/to/ggml-*.bin  overrides model discovery

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { usage; exit 0; }

MODEL_DIR="$HOME/.cache/whisper-cpp"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

if [[ "${1:-}" == "--download-model" ]]; then
  need curl
  mkdir -p "$MODEL_DIR"
  echo "Downloading base.en model (~142 MB) to $MODEL_DIR ..."
  curl -L --fail --progress-bar -o "$MODEL_DIR/ggml-base.en.bin.part" "$MODEL_URL"
  mv "$MODEL_DIR/ggml-base.en.bin.part" "$MODEL_DIR/ggml-base.en.bin"
  echo "Done: $MODEL_DIR/ggml-base.en.bin"
  exit 0
fi

[[ $# -lt 2 ]] && { usage; exit 1; }
need ffmpeg; need whisper-cli
FILE=$1; OUT_DIR=$2
[[ -f "$FILE" ]] || die "file not found: $FILE"
mkdir -p "$OUT_DIR"

MODEL=""
for m in "${WHISPER_MODEL:-}" "$MODEL_DIR/ggml-base.en.bin" "$MODEL_DIR/ggml-small.en.bin"; do
  [[ -n "$m" && -f "$m" ]] && { MODEL=$m; break; }
done
[[ -n "$MODEL" ]] || die "no whisper model found. Run: transcribe.sh --download-model"

base=$(basename "$FILE"); base=${base%.*}
prefix="$OUT_DIR/$base"
assert_output_path "$prefix.json"

wav=$(mktemp -t demoedit).wav
trap 'rm -f "$wav"' EXIT
ffmpeg -y -v error -i "$FILE" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$wav"

whisper-cli -m "$MODEL" -f "$wav" -ml 1 -oj -osrt -of "$prefix" >/dev/null
echo "Transcript: $prefix.json  $prefix.srt"

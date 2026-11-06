#!/usr/bin/env bash
# Verify the tools the demo editor needs. Exits non-zero if a required tool is missing.
set -euo pipefail

usage() { echo "usage: check-tools.sh   (no arguments; prints tool status)"; }
[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { usage; exit 0; }

missing=0
req() {
  if command -v "$1" >/dev/null 2>&1; then
    printf 'OK       %-12s %s\n' "$1" "$(command -v "$1")"
  else
    printf 'MISSING  %-12s %s\n' "$1" "$2"
    missing=1
  fi
}

req ffmpeg  "install with: brew install ffmpeg"
req ffprobe "ships with ffmpeg: brew install ffmpeg"
req jq      "install with: brew install jq"

echo
ffmpeg -version 2>/dev/null | head -1 || true

echo
if command -v whisper-cli >/dev/null 2>&1; then
  model=""
  for m in "${WHISPER_MODEL:-}" \
           "$HOME/.cache/whisper-cpp/ggml-base.en.bin" \
           "$HOME/.cache/whisper-cpp/ggml-small.en.bin" \
           /opt/homebrew/share/whisper-cpp/ggml-base.en.bin; do
    [[ -n "$m" && -f "$m" ]] && { model=$m; break; }
  done
  if [[ -n "$model" ]]; then
    printf 'OK       whisper-cli  model: %s\n' "$model"
    echo "TRANSCRIPTION: available"
  else
    printf 'PARTIAL  whisper-cli  found, but no model installed\n'
    echo "TRANSCRIPTION: unavailable (run transcribe.sh --download-model to fetch base.en, ~142 MB)"
  fi
else
  printf 'MISSING  whisper-cli  optional; install with: brew install whisper-cpp\n'
  echo "TRANSCRIPTION: unavailable (timestamps will be estimated)"
fi

exit "$missing"

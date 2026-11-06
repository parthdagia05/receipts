---
name: receipts-demo-editor
description: >-
  Automated demo-video editor for hackathon and product demos. Turns a folder of raw
  facecam recordings, screen recordings, B-roll and a narration script into a
  professionally edited 16:9 1080p MP4 using FFmpeg/FFprobe, with an intermediate
  edit plan, a low-res preview, and a final edit report. Use this skill whenever the
  user wants to edit, assemble, or produce a demo video, pitch video, or hackathon
  submission video; combine facecam + screen recordings; align narration to visuals;
  or asks to "cut the demo", "edit my recording", or "make the submission video" —
  even if they don't say "video editing" explicitly.
---

# Demo Video Editor

Turn raw recordings + a narration script into a finished demo video. You (Claude) do the
semantic work — reading the script, matching narration to footage, deciding the cut — and
the bundled scripts do the deterministic media work. Never guess at media facts the
scripts can measure.

**Hard rules, in every phase:**
- Never modify, move, or delete any file inside the input folder. Sources are read-only.
- Everything you generate goes in `<input>/output/` (create it if missing).
- Never fabricate footage, screens, transactions, metrics, or narration. If a scene has
  no matching footage, record it in `output/missing-assets.md` and keep the facecam on
  screen instead.
- Never cut meaningful words. Trim only silence, dead air, and obvious false starts —
  and only at silence boundaries the tools detected.
- Timestamps you could not verify by transcription or by listening get
  `"estimated": true` in the edit plan and a line in the edit report.

All scripts live in `scripts/` next to this file, take `--help`, handle spaces in
filenames, and refuse to write outside the output directory. Set `$SKILL_DIR` to this
skill's directory once and call them as `"$SKILL_DIR/scripts/<name>.sh"`.

## Phase 0 — Preflight

Run `scripts/check-tools.sh`. It verifies ffmpeg, ffprobe and jq (required) and
whisper-cli + a model (optional, enables transcription). If a required tool is missing,
stop and tell the user exactly what to install. If whisper is missing or has no model,
continue — but every narration timestamp becomes an estimate (see Phase 2).

Ask the user for the input folder and script file if not already given. Expected shape
(names vary — always discover what actually exists, never assume):

```
<input>/
├── script.md            # narration script (any name; ask if ambiguous)
├── facecam/             # presenter-to-camera recordings
├── screen-recordings/   # app demos
├── b-roll/              # screenshots, diagrams, extra footage
└── output/              # everything generated lands here
```

## Phase 1 — Discover and probe media

Run `scripts/probe-media.sh <input-dir> <output-dir>`. It walks the folder, probes every
video/image/audio file, and writes `output/media-inventory.json`: path, kind, duration,
resolution, fps, codecs, audio channels/sample-rate, rotation, and an `ok` integrity
flag. Read the inventory and note:

- Which clips are facecam vs screen vs B-roll (folder names, then resolution/content).
- Any corrupt file (`ok: false`) → list in missing-assets.md, do not use it.
- Portrait or rotated clips → they'll be pillarboxed; warn the user.
- Mixed fps/resolutions are fine; rendering normalizes everything to 1920×1080/30fps.

Pass `--verify` for a full-decode integrity check when a file looks suspicious (slow).

## Phase 2 — Understand the narration

1. Read the script file. Split it into sections (intro, problem, product, architecture,
   each demo, closing — whatever the script actually contains; don't force a template).
2. Transcribe each facecam clip: `scripts/transcribe.sh <clip> <output-dir>/transcripts`.
   It extracts audio and runs whisper-cli, producing word-level JSON + SRT. If no model
   is installed it prints the download command; ask the user before downloading (~142 MB),
   or proceed without transcription.
3. Align transcript to script sections. The spoken words win: if the presenter deviated
   from the script, follow the recording and note the discrepancy in the edit report.
   Never synthesize or re-order speech to match the script.
4. Determine facecam clip order from filenames, file timestamps, and transcript
   continuity (the end of one clip's sentence flowing into the next).
5. Run `scripts/detect-silence.sh <clip>` on each facecam clip. Use the silence table to
   pick clean cut points: trim leading/trailing dead air, and cut long mid-clip pauses
   (>1.5 s) only when the transcript confirms no words are lost.

Without transcription: derive section boundaries from clip durations, filenames and the
script's proportions, mark every such timestamp `"estimated": true`, and tell the user
these need review in the preview.

## Phase 3 — Plan the edit

Write `output/edit-plan.json`. Schema and a full example:
`references/edit-plan-schema.md` — read it before writing the plan.

Visual grammar (one scene per script section, facecam is the backbone):

- **Facecam full-screen** for intro, problem, architecture talk, closing.
- **Screen recording full-screen** while the narration describes that exact feature —
  narration audio always comes from the facecam track underneath.
- **Picture-in-picture** (screen large, facecam bottom-right ~22%) when seeing the
  presenter helps but the demo matters more — good for walkthrough middles.
- **Stills/B-roll full-screen** (Ken-Burns optional) for diagrams and screenshots, only
  where the narration references them.
- **Title cards** (2.5–3.5 s, fade in/out) to open the video, introduce major chapters,
  and close. Clean typography, consistent colors, no flashy animation.

Match narration to footage semantically — "we verify the reviewer with World ID" shows
the World ID capture, not the landing page. Prefer no overlay over a wrong overlay.
Target 2–4 minutes total, but never cut substantive explanation purely for length; if
the material runs long, tell the user what you'd trim and let them choose.

Then generate `output/ffmpeg-commands.sh`: one `render-segment.sh` call per scene, in
order, followed by the assemble call. This file is the reproducible build — a user can
re-run it alone. Scene media recipes (PiP geometry, xfade joins, Ken Burns, title style):
`references/ffmpeg-recipes.md`.

## Phase 4 — Preview, check, get approval

1. Render everything at preview quality: `PREVIEW=1 bash output/ffmpeg-commands.sh`
   (segments → `output/segments-preview/`, assembled preview →
   `output/preview.mp4`, 640×360, fast encode).
2. QC the preview yourself before showing it:
   - `probe-media.sh` on the preview: duration ≈ plan total, audio stream present.
   - `detect-silence.sh` on the preview: no silence gap > 2 s that the plan doesn't
     explain (a gap usually means a scene with missing audio).
   - Extract a frame from each scene boundary (`ffmpeg -ss <t> -frames:v 1`) and look at
     them: no black frames, titles readable, PiP not covering key UI.
3. Show the user the preview path, the edit plan summary, and any estimated timestamps
   or missing assets. Ask for approval **only** on genuine editorial uncertainty
   (ambiguous footage match, a trim that might clip a word, duration trade-offs) — not
   on routine cuts.

## Phase 5 — Final render

1. `bash output/ffmpeg-commands.sh` (no PREVIEW): full-quality segments →
   `output/segments/`. Segments are skipped if already rendered and newer than the plan,
   so a tweak re-renders only the changed scene. `FORCE=1` re-renders everything.
2. `scripts/assemble.sh` concatenates segments (stream-copy video, no generation loss),
   then runs two-pass loudnorm (−16 LUFS, −1.5 dBTP) on the audio only. Background music,
   only if the user supplied a licensed track and approved it: pass `--music <file>`
   (ducked ~18 dB under speech, never over it).
3. Final file: `<input>/output/Receipts-Demo-Final.mp4` — or `<Project>-Demo-Final.mp4`
   for other projects. 1920×1080, H.264 high profile, yuv420p, CRF 18, AAC 192k.

## Phase 6 — Report

Write `output/edit-report.md`: total duration, scene table (number, section, visuals,
sources, timestamps, transition), source files used/unused, audio processing (measured
loudnorm values), every estimated timestamp, transcript-vs-script discrepancies, and
anything needing manual attention. Keep `output/missing-assets.md` only if it has
entries. Finish by giving the user the final path, duration, and the two or three
things most worth a human double-check.

## Script reference

| Script | Purpose |
|---|---|
| `check-tools.sh` | Verify ffmpeg/ffprobe/jq, report whisper availability |
| `probe-media.sh <in> <out> [--verify]` | Media inventory → `media-inventory.json` |
| `transcribe.sh <clip> <outdir>` | Whisper word-level JSON + SRT (`--download-model` to fetch base.en) |
| `detect-silence.sh <clip> [noise_dB] [min_s]` | Silence intervals as TSV |
| `make-title-card.sh --out F --title T [...]` | Title-card segment with fades |
| `render-segment.sh --mode M --out F [...]` | One scene → normalized segment (modes: facecam, screen, pip, still, title) |
| `assemble.sh <segments-dir> <final.mp4> [--music F]` | Concat + two-pass loudnorm |

Every render honors `PREVIEW=1` (640×360 ultrafast) and skip-if-exists (`FORCE=1`
overrides). Run any script with `--help` for exact arguments.

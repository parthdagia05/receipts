# edit-plan.json schema

The edit plan is the single source of truth for the cut. Write it before rendering
anything; regenerate `ffmpeg-commands.sh` from it whenever it changes.

## Top level

```json
{
  "project": "Receipts",
  "target": { "width": 1920, "height": 1080, "fps": 30, "max_minutes": 4 },
  "script_file": "script.md",
  "total_duration_s": 178.4,
  "scenes": [ ... ]
}
```

## Scene object

Every scene becomes exactly one segment file `output/segments/NN-<slug>.mp4`.

```json
{
  "scene": 3,
  "slug": "world-id-demo",
  "section": "World ID demonstration",
  "narration": "We use World ID to verify that a reviewer is a real human...",
  "mode": "screen",
  "facecam": { "file": "facecam/recording-01.mp4", "in": 42.10, "out": 61.85 },
  "screen":  { "file": "screen-recordings/world-id-demo.mp4", "in": 2.0 },
  "broll": null,
  "title": null,
  "transition_in": "cut",
  "duration_s": 19.75,
  "estimated": false,
  "notes": "transcript-aligned; screen clip starts after its loading spinner"
}
```

Field meaning:

- `mode` — `facecam` | `screen` | `pip` | `still` | `title`. Decides the
  `render-segment.sh` call. In every non-title mode the **facecam `in`/`out` range is
  the narration audio** and fixes the scene duration.
- `facecam.in/out` — seconds in the facecam source. From word-level transcript when
  available; otherwise estimated (and `estimated: true`).
- `screen.in` — where the screen recording starts playing. It plays for the scene
  duration; if shorter, its last frame holds (flag scenes where that hold exceeds ~2 s —
  usually better to switch back to facecam).
- `broll` — `{ "file": ..., "in": ... }` for `still`/B-roll scenes (images use no `in`).
- `title` — `{ "text": ..., "subtitle": ..., "duration_s": 3.0 }` for title scenes
  (no facecam range; title cards carry silent audio).
- `transition_in` — `cut` (default) or `xfade-0.4`. Title cards already fade
  internally, so `cut` into/out of them looks like a dissolve. Use `xfade` sparingly;
  it requires joint re-encoding of the two neighbors (recipe in ffmpeg-recipes.md).
- `estimated` — true whenever any timestamp was not confirmed by transcription or
  listening. These must be listed in the edit report and re-checked at preview.
- `notes` — why this footage matches this narration, plus anything a human should check.

## Invariants (check before rendering)

- Scene numbers are contiguous from 1 and match the `NN-` prefix of segment filenames.
- Facecam ranges never overlap and never skip spoken words (verify against transcript
  and the silence table — every cut boundary should sit inside a detected silence).
- `duration_s` = `facecam.out - facecam.in` (or `title.duration_s`).
- Sum of `duration_s` = `total_duration_s`.
- Every referenced file exists in `media-inventory.json` with `ok: true`.
- A missing visual never invents one: fall back to `mode: facecam` and record the gap
  in `missing-assets.md`.

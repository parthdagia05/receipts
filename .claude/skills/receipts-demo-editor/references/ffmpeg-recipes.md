# FFmpeg recipes

Recipes the bundled scripts don't cover, plus the reasoning behind their defaults.
`render-segment.sh` already handles trim/normalize, full-screen screen recordings,
PiP, stills and title cards — reach for these only for the cases below.

## Why segments + concat

Each scene renders once to an identically-coded segment (H.264 high, yuv420p,
1920×1080@30, AAC 48 kHz stereo). Assembly then uses the concat **demuxer** with
`-c copy`: no second generation of video encoding, and a changed scene re-renders alone
(`FORCE=1` only for full rebuilds). Concat demuxer requires identical codec parameters
across segments — that's why every segment goes through the same `render_settings`,
and why you must never drop a foreign-encoded file into the segments directory.

## Smooth facecam joins inside one scene

When one scene spans two facecam files (recording-01 ends mid-section, recording-02
continues), join them inside a single segment with a short crossfade so the cut
doesn't pop. Cut at detected silences on both sides, then:

```sh
ffmpeg -y -ss "$IN1" -to "$TO1" -i "$F1" -ss "$IN2" -to "$TO2" -i "$F2" \
  -filter_complex "\
[0:v]<VF_NORM>[v0];[1:v]<VF_NORM>[v1];\
[0:a]aresample=48000[a0];[1:a]aresample=48000[a1];\
[v0][v1]xfade=transition=fade:duration=0.25:offset=$OFFSET[v];\
[a0][a1]acrossfade=d=0.25[a]" \
  -map "[v]" -map "[a]" <VCODEC> <ACODEC> "$OUT"
```

`OFFSET` = (TO1 − IN1) − 0.25. Replace `<VF_NORM>`, `<VCODEC>`, `<ACODEC>` with the
values from `lib.sh`'s `render_settings` so the result still concats cleanly.
Keep the crossfade ≤ 0.3 s: longer ones smear speech. If both cut points sit in real
silence, a straight concat (two segments, plain cut) is often invisible — try that first.

## xfade between two finished segments

For a `transition_in: xfade-0.4` scene, re-encode the boundary pair into one combined
segment and remove the two originals from the segments dir (keep numbering sorted):

```sh
A_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 -- "$A")
OFF=$(echo "$A_DUR - 0.4" | bc)
ffmpeg -y -i "$A" -i "$B" -filter_complex \
  "[0:v][1:v]xfade=transition=fade:duration=0.4:offset=${OFF}[v];\
   [0:a][1:a]acrossfade=d=0.4[a]" \
  -map "[v]" -map "[a]" <VCODEC> <ACODEC> "$AB"
```

Never crossfade in the middle of a spoken sentence — the acrossfade dips both tracks.
Reserve it for boundaries where the narration pauses (into/out of title cards it's
unnecessary; their built-in fades to the dark background already read as a dissolve).

## Cropping a screen recording to a UI region

When only part of the screen matters (e.g. a transaction hash in an explorer), crop
before the normalize chain, keeping even dimensions:

```sh
-filter_complex "[1:v]crop=1280:800:x=320:y=140,<VF_NORM>,tpad=...[v]"
```

Inspect first (`ffmpeg -ss T -frames:v 1 frame.png`) and crop generously — hiding
context is worse than small UI. Never crop out the elements the narration refers to.

## Speeding up slow UI stretches

Long waits inside a demo recording (spinners, block confirmations) can be sped up
without touching narration, because screen/pip scenes take audio from the facecam:

```sh
[1:v]trim=start=0:end=4,setpts=PTS-STARTPTS[pre];
[1:v]trim=start=4:end=24,setpts=(PTS-STARTPTS)/4[fast];
[1:v]trim=start=24,setpts=PTS-STARTPTS[post];
[pre][fast][post]concat=n=3:v=1:a=0,<VF_NORM>[v]
```

Label sped-up stretches honestly in the edit report. Don't speed up the parts the
narration is actively describing.

## Audio cleanup beyond loudnorm

`assemble.sh` already does two-pass loudnorm. For noticeable room noise/hiss on the
facecam, add gentle filtering **per facecam segment** (safe defaults; aggressive
denoise makes speech watery — when in doubt, skip):

```sh
-af "highpass=f=70,afftdn=nr=10:nf=-28,aresample=48000"
```

A/B a 10-second excerpt first and keep the original if unsure. Never apply dynamic
compression on top of loudnorm's linear mode.

## QC one-liners

```sh
# frame at each scene boundary (run per boundary time T)
ffmpeg -y -v error -ss "$T" -i final.mp4 -frames:v 1 "check_$T.png"

# black-frame detection over the whole video
ffmpeg -i final.mp4 -vf blackdetect=d=0.2:pix_th=0.04 -an -f null - 2>&1 | grep black

# audio gaps (anything over ~2 s is suspicious in a narrated demo)
ffmpeg -i final.mp4 -af silencedetect=noise=-45dB:d=2 -f null - 2>&1 | grep silence

# stream summary of the final file
ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate,sample_rate,channels -of compact final.mp4
```

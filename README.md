# MuseArena Studio

**[Launch MuseArena Studio on Vercel](https://musearena-studio.vercel.app/)**

A browser music workstation with instrument audition, live capture, a step sequencer, timeline editing, effects, and WAV and MIDI export. Projects are saved on this browser. Imported audio and voice recordings stay in browser storage. Export a WAV to share a mix containing local recordings.

## Run

Run `python -m http.server 8080 --directory public` and open http://localhost:8080/player/. The Vercel configuration publishes the same public directory. GitHub and hosting credentials belong in the operator's credential manager.

## Sound library

The 80 instruments are drawn from Versilian Community Sample Library and VSCO 2 Community Edition. Both upstream repositories supply the CC0 dedication. Source links are included per instrument in `public/library/index.json`, and the dedications are in `public/library/LICENSE-*.txt`. The samples are compressed to MP3 for browser playback.

The hosted studio has no AI provider, server-side transcription, or pitch-preserving time-stretch service. It requires no API keys. Its content security policy permits same-origin application scripts, and Google Fonts supplies interface fonts.

## Checks

Run `node --test scripts/check_*.cjs` with Node 22 or newer and `python scripts/check_release.py` to validate the release contents.

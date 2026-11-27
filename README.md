# MuseArena Studio

A browser music workstation with instrument audition, live capture, a step sequencer, timeline editing, effects, and WAV and MIDI export. Projects are saved on this browser. Imported audio and voice recordings stay in browser storage. Export a WAV to share a mix containing local recordings.

## Run

Run `python -m http.server 8080 --directory public` and open http://localhost:8080/player/. The Vercel configuration publishes the same public directory. GitHub and hosting credentials belong in the operator's credential manager.

## Sound library

The 80 instruments are drawn from Versilian Community Sample Library and VSCO 2 Community Edition. Both upstream repositories supply the CC0 dedication. Source links are included per instrument in `public/library/index.json`, and the dedications are in `public/library/LICENSE-*.txt`. The samples are compressed to MP3 for browser playback.

AI Melody runs the pretrained Magenta basic_rnn model in a Web Worker and adds editable notes to a project. The first generation downloads 13 MB from the studio origin. The checkpoint source is https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/basic_rnn/ and the upstream model documentation is https://github.com/magenta/magenta-js/tree/master/music. Server-side transcription and pitch-preserving time stretching remain desktop features. It requires no API keys. Its content security policy permits same-origin application scripts, and Google Fonts supplies interface fonts.

## Checks

Run `node --test scripts/check_*.cjs` with Node 22 or newer and `python scripts/check_release.py` to validate the release contents.

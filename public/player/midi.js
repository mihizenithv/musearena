// Standard MIDI File (type 1) writer. Pure: no DOM, no Web Audio. Times are seconds.
// Bends use a ±12 semitone range (set by RPN 0 on each pitched track) so large meends survive.
import { bendPoints } from "./project.js";

export const PPQ = 960;
export const BEND_RANGE_CENTS = 1200;
const GM_DRUMS = [35, 38, 42]; // low / mid / high onset bands

const vlq = (value) => {
  const bytes = [value & 0x7f];
  while ((value >>= 7)) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s) => [...new TextEncoder().encode(s.slice(0, 120))];
export const bendValue = (cents) => Math.max(0, Math.min(16383, Math.round(8192 + (cents / BEND_RANGE_CENTS) * 8191)));

// Pair scheduled events (clipEvents output, or a pattern's raw events) into notes and hits.
export function notesFromEvents(events) {
  const notes = [], open = new Map();
  for (const event of [...events].sort((a, b) => a.t - b.t || (a.type === "off" ? -1 : 1))) {
    const key = (event.layerIndex ?? 0) + ":" + event.m;
    if (event.type === "hit") notes.push({ t: event.t, d: 0.1, drum: true, i: event.i, band: event.band, vel: event.vel });
    else if (event.type === "on") {
      if (open.has(key)) { const prev = open.get(key); prev.d = Math.max(0.001, event.t - prev.t); open.delete(key); }
      const note = { t: event.t, d: 0.25, m: event.m, vel: event.vel ?? 0.8, bend: event.bend, sourceOffset: event.sourceOffset || 0 };
      notes.push(note); open.set(key, note);
    } else if (open.has(key)) {
      const note = open.get(key); note.d = Math.max(0.001, event.t - note.t); open.delete(key);
    }
  }
  return notes;
}

// tracks: [{ name, notes: notesFromEvents(...) }]. Returns a Uint8Array .mid file.
export function encodeMidi(tracks, bpm = 90, songName = "MuseArena") {
  const tick = (sec) => Math.max(0, Math.round((sec * bpm * PPQ) / 60));
  const usPerBeat = Math.round(60000000 / bpm);
  const chunks = [[0, 0xff, 0x03, ...vlq(text(songName).length), ...text(songName),
    0, 0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255,
    0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xff, 0x2f, 0]];
  let channel = 0;
  for (const track of tracks) {
    const drums = track.notes.some((note) => note.drum);
    const ch = drums ? 9 : channel;
    if (!drums) channel = channel === 8 ? 10 : (channel + 1) % 16;
    const msgs = []; // [tick, order, bytes]; order keeps offs before ons at equal ticks
    const name = text(track.name || "Track");
    msgs.push([0, 0, [0xff, 0x03, ...vlq(name.length), ...name]]);
    if (!drums) msgs.push([0, 0, [0xb0 | ch, 101, 0]], [0, 0, [0xb0 | ch, 100, 0]], [0, 0, [0xb0 | ch, 6, BEND_RANGE_CENTS / 100]], [0, 0, [0xb0 | ch, 38, 0]]);
    for (const note of track.notes) {
      const key = note.drum ? (GM_DRUMS[note.band ?? note.i] ?? 36 + (note.i % 12)) : note.m;
      const vel = Math.max(1, Math.min(127, Math.round((note.vel ?? 0.8) * 127)));
      const on = tick(note.t), off = Math.max(on + 1, tick(note.t + note.d));
      if (!note.drum && note.bend) {
        for (const p of bendPoints(note.bend, note.sourceOffset)) {
          if (p.dt >= note.d) break;
          const v = bendValue(p.cents);
          msgs.push([tick(note.t + p.dt), 1, [0xe0 | ch, v & 127, v >> 7]]);
        }
        msgs.push([off, 0, [0xe0 | ch, 0, 64]]); // back to centre after the note
      }
      msgs.push([on, 2, [0x90 | ch, key, vel]], [off, 0, [0x80 | ch, key, 0]]);
    }
    msgs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const data = []; let last = 0;
    for (const [t, , bytes] of msgs) { data.push(...vlq(t - last), ...bytes); last = t; }
    data.push(0, 0xff, 0x2f, 0);
    chunks.push(data);
  }
  const out = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, chunks.length, PPQ >> 8, PPQ & 255];
  for (const c of chunks) out.push(0x4d, 0x54, 0x72, 0x6b, ...u32(c.length), ...c);
  return new Uint8Array(out);
}

// 16-bit PCM WAV from an AudioBuffer-like { numberOfChannels, sampleRate, length, getChannelData }.
export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); data.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVE"); str(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, buffer.sampleRate, true); data.setUint32(28, buffer.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); str(36, "data"); data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) {
    const s = Math.max(-1, Math.min(1, chans[c][i]));
    data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(data.buffer);
}

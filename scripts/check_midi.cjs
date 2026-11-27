const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeMidi, encodeWav, notesFromEvents, bendValue, PPQ } = require('../public/player/midi.js');
const { createProject, clipEvents } = require('../public/player/project.js');

// Minimal SMF reader: returns tempo, ppq and per-track [{sec, status, a, b}] for channel messages.
function readMidi(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  const ntrk = dv.getUint16(10), ppq = dv.getUint16(12);
  let pos = 14, usPerBeat = 500000; const tracks = [];
  for (let k = 0; k < ntrk; k++) {
    assert.equal(String.fromCharCode(...bytes.slice(pos, pos + 4)), 'MTrk');
    const end = pos + 8 + dv.getUint32(pos + 4); pos += 8;
    let tick = 0, running = 0; const msgs = [];
    const vlq = () => { let v = 0, b; do { b = bytes[pos++]; v = (v << 7) | (b & 127); } while (b & 128); return v; };
    while (pos < end) {
      tick += vlq();
      let status = bytes[pos];
      if (status === 0xff) { const type = bytes[pos + 1]; pos += 2; const len = vlq(); if (type === 0x51) usPerBeat = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2]; pos += len; continue; }
      if (status & 128) { running = status; pos++; } else status = running;
      const a = bytes[pos++], b = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 0 : bytes[pos++];
      msgs.push({ tick, status, a, b });
    }
    tracks.push(msgs);
  }
  return { ppq, tracks: tracks.map(msgs => msgs.map(m => ({ ...m, sec: m.tick * usPerBeat / 1e6 / ppq }))) };
}

test('exported notes re-import at the played micro-timing (±1 ms), never quantised', () => {
  const played = [0.0137, 0.4021, 0.7779, 1.2333];
  const events = played.flatMap((t, i) => [{ type: 'on', t, m: 60 + i, vel: .8 }, { type: 'off', t: t + .2113, m: 60 + i }]);
  const { tracks, ppq } = readMidi(encodeMidi([{ name: 'Bansuri', notes: notesFromEvents(events) }], 90));
  assert.equal(ppq, PPQ);
  const ons = tracks[1].filter(m => (m.status & 0xf0) === 0x90 && m.b > 0), offs = tracks[1].filter(m => (m.status & 0xf0) === 0x80);
  assert.equal(ons.length, 4);
  ons.forEach((m, i) => { assert.ok(Math.abs(m.sec - played[i]) < .001, `on ${i}: ${m.sec}`); assert.equal(m.a, 60 + i); });
  offs.forEach((m, i) => assert.ok(Math.abs(m.sec - (played[i] + .2113)) < .001));
});

test('song export follows clip start, offset and repeats', () => {
  const project = createProject(), pattern = project.patterns[0]; pattern.lengthSec = 1;
  pattern.layers.push({ id: 'l', instrumentId: 'x', flow: 0, choke: false, muted: false, events: [{ type: 'on', t: .25, m: 62, vel: .7 }, { type: 'off', t: .5, m: 62 }] });
  const clip = { id: 'c', kind: 'pattern', ref: pattern.id, lane: 0, start: 2, length: 3, loopLength: 1, trimStart: 0, fadeIn: 0, fadeOut: 0, offsetMs: 12 };
  const { tracks } = readMidi(encodeMidi([{ name: 'Lane 1', notes: notesFromEvents(clipEvents(pattern, clip)) }], 120));
  const ons = tracks[1].filter(m => (m.status & 0xf0) === 0x90).map(m => +m.sec.toFixed(3));
  assert.deepEqual(ons, [2.262, 3.262, 4.262]);
});

test('meend curves export as pitch bend with a ±12 semitone range, then return to centre', () => {
  const events = [{ type: 'on', t: 0, m: 64, vel: .8, bend: { rate: 10, cents: [-200, 0, 150] } }, { type: 'off', t: 1, m: 64 }];
  const { tracks } = readMidi(encodeMidi([{ name: 'Hum', notes: notesFromEvents(events) }], 90));
  const rpn = tracks[1].filter(m => (m.status & 0xf0) === 0xb0).map(m => [m.a, m.b]);
  assert.deepEqual(rpn, [[101, 0], [100, 0], [6, 12], [38, 0]]);
  const bends = tracks[1].filter(m => (m.status & 0xf0) === 0xe0).map(m => [+m.sec.toFixed(2), m.a | (m.b << 7)]);
  assert.deepEqual(bends, [[0, bendValue(-200)], [.1, 8192], [.2, bendValue(150)], [1, 8192]]);
  assert.ok(bendValue(-200) < 8192 && bendValue(150) > 8192);
});

test('pad hits go to the GM drum channel by onset band', () => {
  const { tracks } = readMidi(encodeMidi([{ name: 'Tabla', notes: notesFromEvents([{ type: 'hit', t: .1, i: 4, band: 0, vel: 1 }, { type: 'hit', t: .3, i: 2, vel: .5 }]) }], 90));
  const ons = tracks[1].filter(m => (m.status & 0xf0) === 0x90);
  assert.ok(ons.every(m => (m.status & 15) === 9)); assert.deepEqual(ons.map(m => m.a), [35, 38 + 4]);
});

test('WAV encoder writes a valid 16-bit stereo header and clamps samples', () => {
  const left = new Float32Array([0, .5, 2]), right = new Float32Array([0, -.5, -2]);
  const wav = encodeWav({ numberOfChannels: 2, sampleRate: 48000, length: 3, getChannelData: c => c ? right : left });
  const dv = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF'); assert.equal(dv.getUint32(24, true), 48000);
  assert.equal(dv.getUint16(22, true), 2); assert.equal(wav.length, 44 + 12);
  assert.equal(dv.getInt16(48, true), 16383); assert.equal(dv.getInt16(52, true), 32767); assert.equal(dv.getInt16(54, true), -32768);
});

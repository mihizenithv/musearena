const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProject, duplicatePattern, projectData, validateProject, clipEvents } = require('../public/player/project.js');
const { patternFromTranscription, defaultInstrument, generatedLayer, revoicedEvents } = require('../public/player/transcription.js');
const keyboard = { id: 'sitar', name: 'Sitar', kind: 'melodic', notes: { 60: 'sample' } };
const pads = { id: 'tabla', name: 'GM Tabla', kind: 'pads', pads: [{}, {}, {}] };
const fields = { model: 'lyria-3-clip-preview', role: 'melody', mono: true, genre: 'World', padMap: [2, 0, 1] };
function response() {
  return { url: '/output/generated/stem.mp3', transcription: { ok: true, kind: 'notes', midiUrl: '/output/generated/stem-melody.mid',
    events: [{ type: 'on', t: 1.234, m: 60, vel: .7 }, { type: 'off', t: 1.75, m: 60 }],
    notes: [{ t: 1.234, d: .516, m: 60, vel: .7, bendCents: [0, 33.3, 66.7, 0], bendRate: 86.133 }] } };
}
test('transcription creates seconds-based instrument events, never an audio layer', () => {
  const result = response(), pattern = patternFromTranscription(result, fields, keyboard, 2.5, 50);
  assert.equal(pattern.lengthSec, 2.5); assert.equal(pattern.layers[0].instrumentId, 'sitar');
  assert.equal(pattern.layers[0].kind, undefined); assert.equal(pattern.layers[0].flow, 50);
  const note = result.transcription.notes[0];
  assert.deepEqual(pattern.layers[0].events, result.transcription.events.map(event => event.type === 'on' && event.m === note.m && event.t === note.t
    ? { ...event, bend: { rate: note.bendRate, cents: note.bendCents } } : event), 'notes carry their pitch curve for playback');
  const events = clipEvents(pattern, { start: 4, length: 2.5, loopLength: 2.5, trimStart: 0, offsetMs: 0 });
  assert.equal(events[0].t, 5.234); assert.equal(events[1].t, 5.75);
});
test('low/mid/high onset classes map to explicit chosen instrument pads', () => {
  const result = response(); result.transcription = { ok: true, kind: 'hits', notes: [], midiUrl: '/output/generated/stem-percussion.mid',
    events: [0, 1, 2].map(i => ({ type: 'hit', t: .25 + i, i, vel: .8 })) };
  const pattern = patternFromTranscription(result, { ...fields, role: 'percussion', mono: false }, pads, 3);
  assert.deepEqual(pattern.layers[0].events.map(event => event.i), [2, 0, 1]);
  assert.equal(pattern.layers[0].instrumentId, 'tabla');
  assert.throws(() => patternFromTranscription(result, { ...fields, role: 'percussion', padMap: [0, 1, 7] }, pads, 3), /pad mappings/);
  assert.throws(() => patternFromTranscription(result, { ...fields, role: 'percussion' }, keyboard, 3), /compatible/);
});
test('bend envelopes and source/download metadata survive JSON and independent pattern duplication', () => {
  const pattern = patternFromTranscription(response(), fields, keyboard, 2.5);
  const project = createProject(); project.patterns = [pattern]; project.activePatternId = pattern.id;
  const restored = validateProject(JSON.parse(JSON.stringify(projectData(project))), [keyboard]);
  assert.deepEqual(restored.patterns[0].source.notes, response().transcription.notes);
  assert.equal(restored.patterns[0].source.midiUrl, '/output/generated/stem-melody.mid');
  const copy = duplicatePattern(pattern); copy.source.notes[0].bendCents[1] = 999;
  assert.equal(pattern.source.notes[0].bendCents[1], 33.3);
  assert.equal(copy.source.layerId, copy.layers[0].id);
  assert.equal(generatedLayer(copy), copy.layers[0]);
});

test('revoicing retains all melodic timing, pitch, velocity and source bends', () => {
  const pattern = patternFromTranscription(response(), fields, keyboard, 2.5);
  const before = structuredClone(pattern), piano = { ...keyboard, id: 'piano', name: 'Piano' };
  const events = revoicedEvents(generatedLayer(pattern), piano);
  assert.deepEqual(events, before.layers[0].events);
  assert.notEqual(events, pattern.layers[0].events);
  assert.deepEqual(pattern.source, before.source);
  assert.throws(() => revoicedEvents(pattern.layers[0], pads), /keyboard instrument/);
});

test('percussion revoicing preserves the original onset bands across repeated pad remaps and JSON', () => {
  const result = response(); result.transcription = { ok: true, kind: 'hits', notes: [], midiUrl: '/output/generated/stem.mid',
    events: [0, 1, 2].map(i => ({ type: 'hit', t: i, i, vel: .8 })) };
  const pattern = patternFromTranscription(result, { ...fields, role: 'percussion' }, pads, 3);
  const layer = generatedLayer(pattern), first = revoicedEvents(layer, pads, [1, 2, 0]);
  assert.deepEqual(first.map(event => event.i), [1, 2, 0]);
  layer.events = revoicedEvents({ ...layer, events: first }, pads, [0, 1, 2]);
  assert.deepEqual(layer.events.map(event => event.i), [0, 1, 2]);
  const project = createProject(); project.patterns = [pattern]; project.activePatternId = pattern.id;
  assert.deepEqual(validateProject(projectData(project), [pads]).patterns[0].layers[0].events.map(event => event.band), [0, 1, 2]);
});
test('empty, failed, wrong-kind and malformed transcriptions do not produce patterns', () => {
  for (const mutate of [
    result => { result.transcription.events = []; }, result => { result.transcription.ok = false; },
    result => { result.transcription.kind = 'hits'; }, result => { result.transcription.events[0].t = NaN; },
    result => { result.transcription.events[0].vel = 2; }, result => { result.transcription.midiUrl = 'https://example.com/secret.mid'; },
    result => { result.url = '/output/generated/../private.wav'; }, result => { result.transcription.notes[0].bendRate = 0; },
  ]) { const result = response(); mutate(result); assert.throws(() => patternFromTranscription(result, fields, keyboard, 2.5)); }
});
test('role defaults use compatible bass, drone, melody and percussion instruments', () => {
  const bass = { ...keyboard, id: 'bass', name: 'Acoustic Bass' }, drone = { ...keyboard, id: 'drone', name: 'Harmonium' };
  const instruments = [keyboard, pads, bass, drone];
  assert.equal(defaultInstrument(instruments, 'bass'), bass);
  assert.equal(defaultInstrument(instruments, 'drone'), drone);
  const tanpura = { ...keyboard, id: 'tanpura', name: 'Tanpura' };
  assert.equal(defaultInstrument([...instruments, tanpura], 'drone'), tanpura);
  assert.equal(defaultInstrument(instruments, 'melody'), keyboard);
  assert.equal(defaultInstrument(instruments, 'percussion'), pads);
});

test('hummed tunes preserve their own safe audio/MIDI provenance and singer bends', () => {
  const result = response(); result.audioUrl = '/output/hums/recording.wav';
  result.transcription.midiUrl = '/output/hums/recording-hum.mid'; result.transcription.warning = 'A few quiet notes may have been skipped.';
  const pattern = patternFromTranscription(result, {...fields, role:'hum',model:'hum'}, keyboard, 2.5);
  assert.equal(pattern.source.kind,'hum'); assert.equal(pattern.source.url,result.audioUrl);
  assert.deepEqual(pattern.source.notes,result.transcription.notes); assert.equal(pattern.source.warning,result.transcription.warning);
  const project=createProject(); project.patterns=[pattern]; project.activePatternId=pattern.id;
  assert.deepEqual(validateProject(projectData(project),[keyboard]).patterns[0],pattern);
  result.audioUrl='/output/hums/../private.wav';
  assert.throws(()=>patternFromTranscription(result,{...fields,role:'hum',model:'hum'},keyboard,2.5),/asset URL/);
});
test('a long model stem only becomes the requested length (server reports transcription.lengthSec)', () => {
  // 2026-11-24: Lyria 3.5 returned 65 s for a 10 s request; the beat must be 10.667 s (4 bars), not 65 s of silence.
  const result = response(); result.transcription.lengthSec = 10.6667;
  const pattern = patternFromTranscription(result, fields, keyboard, 65.1, 25);
  assert.equal(pattern.lengthSec, 10.6667);
  assert.equal(pattern.source.duration, 65.1, 'the original audio keeps its real duration for A/B');
  const short = response(); short.transcription.lengthSec = 10.6667;
  assert.equal(patternFromTranscription(short, fields, keyboard, 8, 25).lengthSec, 8, 'audio shorter than the limit keeps its own length');
});

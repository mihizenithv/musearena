const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProject, duplicatePattern, clipEvents, projectData, validateProject, snapTime, sliceClip, glueClips, attachBends, bendPoints } = require('../public/player/project.js');

function fixture() {
  const project = createProject();
  const pattern = project.patterns[0]; pattern.lengthSec = 2;
  pattern.layers.push({ id: 'layer-1', instrumentId: 'sitar', flow: 75, choke: false, muted: false,
    events: [{ type: 'on', m: 60, vel: .8, t: 0 }, { type: 'off', m: 60, t: 1.5 }] });
  const clip = { id: 'clip-1', kind: 'pattern', ref: pattern.id, lane: 0, start: 4, length: 4, loopLength: 2, trimStart: 0, fadeIn: 0, fadeOut: 0, offsetMs: 0 };
  project.arrangement.clips.push(clip);
  return { project, pattern, clip };
}

function audioFixture() {
  const { project, pattern, clip } = fixture();
  pattern.layers = [{ id: 'audio-layer', kind: 'audio', audio: { url: '/output/generated/stem.mp3', duration: 2, model: 'lyria-3-clip-preview' },
    muted: false, flow: 0, choke: false, events: [], buffer: { runtime: true } }];
  return { project, pattern, clip };
}

test('audio repeats, seeks into trimmed content and stops at loop boundaries', () => {
  const { pattern, clip } = audioFixture();
  clip.trimStart = .5;
  assert.deepEqual(clipEvents(pattern, clip, 90).map(({ t, duration, sourceOffset }) => [t, duration, sourceOffset]),
    [[4, 1.5, .5], [5.5, 2, 0], [7.5, .5, 0]]);
  assert.deepEqual(clipEvents(pattern, clip, 90, 4.75, 6).map(({ t, duration, sourceOffset }) => [t, duration, sourceOffset]),
    [[4.75, .75, 1.25], [5.5, .5, 0]]);
  assert.deepEqual(clipEvents(pattern, clip, 90, 0, 64, { mute: true }), []);
});

test('audio slice and glue preserve the exact source phase', () => {
  const { pattern, clip } = audioFixture(); clip.trimStart = .25; clip.offsetMs = 37;
  const parts = sliceClip(clip, 5.125);
  const original = clipEvents(pattern, clip, 90);
  const sliced = parts.flatMap(part => clipEvents(pattern, part, 90));
  for (const event of sliced) {
    const source = original.find(item => event.t >= item.t - 1e-9 && event.t < item.t + item.duration - 1e-9);
    assert.ok(source); assert.ok(Math.abs(event.sourceOffset - (source.sourceOffset + event.t - source.t)) < 1e-8);
  }
  assert.deepEqual(clipEvents(pattern, glueClips(parts), 90), original);
});

test('audio saves only safe local asset metadata, reloads and duplicates without serializing buffers', () => {
  const { project, pattern } = audioFixture();
  const data = projectData(project);
  assert.equal(JSON.stringify(data).includes('runtime'), false);
  assert.deepEqual(validateProject(data), data);
  const copy = duplicatePattern(pattern);
  assert.notEqual(copy.layers[0].id, pattern.layers[0].id);
  assert.equal(copy.layers[0].buffer, pattern.layers[0].buffer);
  copy.layers[0].audio.duration = 1;
  assert.equal(pattern.layers[0].audio.duration, 2);
  for (const url of ['https://example.com/a.mp3', '/output/generated/../secret.wav', '/server/key.wav', '//example.com/a.mp3', '/output/generated/%2e%2e/a.wav']) {
    const bad = structuredClone(data); bad.patterns[0].layers[0].audio.url = url;
    assert.throws(() => validateProject(bad), /audio URL/);
  }
});
test('clip starts at its song time and a longer clip repeats its pattern', () => {
  const { pattern, clip } = fixture();
  assert.deepEqual(clipEvents(pattern, clip, 120).map(event => [event.type, event.t]), [['on', 4], ['off', 5.5], ['on', 6], ['off', 7.5]]);
});
test('millisecond offsets and source timing stay fixed when BPM changes', () => {
  const { pattern, clip } = fixture(); clip.offsetMs = 100;
  assert.equal(clipEvents(pattern, clip, 120)[0].t, 4.1);
  assert.equal(clipEvents(pattern, clip, 60)[0].t, 4.1);
  clip.offsetMs = -100;
  assert.equal(clipEvents(pattern, clip, 120)[0].t, 3.9);
});
test('trimming a clip and slicing a song loop both close held notes', () => {
  const { pattern, clip } = fixture(); clip.length = 1;
  assert.deepEqual(clipEvents(pattern, clip, 120).map(event => event.t), [4, 5]);
  clip.length = 4;
  assert.deepEqual(clipEvents(pattern, clip, 120, 4.5, 6.5).map(event => [event.type, event.t]), [['on', 4.5], ['off', 5.5], ['on', 6], ['off', 6.5]]);
});
test('negative offsets at the song start are cropped, and adjacent notes release before the next attack', () => {
  const { pattern, clip } = fixture(); clip.start = 0; clip.length = 6; clip.offsetMs = -100;
  const events = clipEvents(pattern, clip, 120, 0, 4);
  assert.equal(events[0].t, 0);
  assert.equal(events.at(-1).t, 4);
  pattern.layers[0].events.push({ type: 'on', m: 62, vel: .7, t: 1.5 }, { type: 'off', m: 62, t: 2 });
  clip.offsetMs = 0;
  assert.deepEqual(clipEvents(pattern, clip, 120).filter(event => event.t === 1.5).map(event => event.type), ['off', 'on']);
});
test('percussion repeats within a clip, muted layers are silent, and right boundaries do not double-trigger', () => {
  const { pattern, clip } = fixture();
  pattern.layers[0].events = [{ type: 'hit', i: 0, vel: .9, t: 0 }];
  assert.deepEqual(clipEvents(pattern, clip, 90, 4, 6).map(event => event.t), [4]);
  pattern.layers[0].muted = true;
  assert.deepEqual(clipEvents(pattern, clip, 90), []);
});
test('duplicating a pattern copies events without sharing mutable layers or playback engines', () => {
  const { pattern } = fixture(); pattern.layers[0].inst = { active: true };
  const copy = duplicatePattern(pattern);
  assert.notEqual(copy.id, pattern.id); assert.notEqual(copy.layers[0].id, pattern.layers[0].id);
  assert.equal(copy.layers[0].inst, undefined);
  copy.layers[0].events[0].m = 72;
  assert.equal(pattern.layers[0].events[0].m, 60);
});
test('project JSON round-trips patterns, clips, offsets and loop bounds without runtime objects', () => {
  const { project } = fixture(); project.patterns[0].layers[0].inst = { secretRuntime: true };
  const data = projectData(project), restored = validateProject(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(restored, data);
  assert.ok(!JSON.stringify(data).includes('secretRuntime'));
});
test('imports reject missing patterns, duplicate IDs, invalid timing, unknown instruments, and malformed events', () => {
  const { project } = fixture();
  const mutations = [
    p => { p.schemaVersion = 99; }, p => { p.arrangement.clips[0].ref = 'missing'; },
    p => { p.arrangement.clips[0].start = -1; }, p => { p.arrangement.clips[0].offsetMs = NaN; },
    p => { p.arrangement.loop.end = p.arrangement.loop.start; },
    p => { p.arrangement.clips[0].id = p.patterns[0].id; },
    p => { p.patterns[0].layers[0].events[0].m = 128; },
    p => { p.arrangement.loop.on = 'false'; },
    p => { p.patterns[0].layers[0].events[0].t = 2; },
  ];
  for (const mutate of mutations) { const data = projectData(project); mutate(data); assert.throws(() => validateProject(data), /Invalid project/); }
  assert.throws(() => validateProject(projectData(project), [{ id: 'other' }]), /missing library instrument/);
});
test('free-time snapping supports milliseconds, off, and Alt bypass', () => {
  assert.equal(snapTime(1.234, .01), 1.23); assert.equal(snapTime(1.234, .1), 1.2);
  assert.equal(snapTime(1.234, 1), 1); assert.equal(snapTime(1.234, 0), 1.234);
  assert.equal(snapTime(1.234, 1, true), 1.234);
});
test('slice and glue retain content origin and repeated note timing', () => {
  const { pattern, clip } = fixture();
  const [left, right] = sliceClip(clip, 5.25);
  assert.equal(right.start - right.trimStart, clip.start - clip.trimStart);
  const continuation = clipEvents(pattern, right, 120)[0];
  assert.equal(continuation.originT, 4); assert.equal(continuation.sourceOffset, 1.25);
  const joined = glueClips([right, left]);
  assert.deepEqual(clipEvents(pattern, joined, 120), clipEvents(pattern, clip, 120));
  assert.throws(() => glueClips([left, {...right, trimStart: 0}]), /content phase/);
  assert.throws(() => sliceClip(clip, clip.start), /inside/);
});
test('a lane can override repetition length without changing the pattern or other lanes', () => {
  const { pattern, clip } = fixture();
  assert.equal(clipEvents(pattern, clip, 90, 0, Infinity, {loopLength: .5}).filter(event => event.type === 'on').length, 8);
  assert.equal(clipEvents(pattern, clip, 90).filter(event => event.type === 'on').length, 2);
  assert.deepEqual(clipEvents(pattern, clip, 90, 0, Infinity, {mute: true}), []);
});
test('version-1 saves migrate from bars/beats into stable seconds and save as version 2', () => {
  const old = {schemaVersion: 1, name: 'Legacy', bpm: 120, activePatternId: 'p',
    patterns: [{id: 'p', name: 'Melody', bars: 1, layers: [{id: 'l', instrumentId: 'sitar', flow: 50, muted: false, choke: false,
      events: [{type: 'on', m: 60, vel: .8, beat: 1}, {type: 'off', m: 60, beat: 3}]}]}],
    arrangement: {bars: 8, lanes: 2, loop: {enabled: true, startBar: 1, endBar: 3},
      clips: [{id: 'c', patternId: 'p', lane: 0, startBar: 2, lengthBars: 2, offsetMs: 25}]}};
  const migrated = validateProject(old);
  assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.patterns[0].lengthSec, 2);
  assert.equal(migrated.patterns[0].layers[0].events[0].t, .5);
  assert.equal(migrated.arrangement.clips[0].start, 4); assert.equal(migrated.arrangement.clips[0].length, 4);
  assert.equal(migrated.arrangement.loop.start, 2); assert.equal(migrated.arrangement.loop.end, 6);
  assert.equal(old.schemaVersion, 1); assert.deepEqual(validateProject(projectData(migrated)), projectData(migrated));
});

test('transcribed pitch curves reach note events, survive clip scheduling and save/load', () => {
  const { project, pattern, clip } = fixture();
  pattern.source = { kind: 'hum', url: '/output/hums/a.wav', midiUrl: '/output/hums/a.mid', model: 'pyin', role: 'hum', mono: true, duration: 2,
    notes: [{ t: 0, d: 1.5, m: 60, vel: .8, bendRate: 100, bendCents: [-200, -100, 0, 30, -30] }] };
  pattern.source.layerId = 'layer-1';
  const loaded = validateProject(projectData(project));
  const on = loaded.patterns[0].layers[0].events.find(event => event.type === 'on');
  assert.deepEqual(on.bend, { rate: 100, cents: [-200, -100, 0, 30, -30] });
  const scheduled = clipEvents(loaded.patterns[0], clip).filter(event => event.type === 'on');
  assert.equal(scheduled.length, 2); assert.ok(scheduled.every(event => event.bend.cents.length === 5));
  assert.equal(projectData(loaded).patterns[0].layers[0].events[0].bend, undefined, 'source notes stay the only saved copy');
});

test('bend points start at the attack, skip elapsed curve on resume and thin dense curves', () => {
  const bend = { rate: 100, cents: [-200, -100, 0, 30, -30] };
  assert.deepEqual(bendPoints(bend).map(p => [Math.round(p.dt * 1000), p.cents]), [[0, -200], [10, -100], [20, 0], [30, 30], [40, -30]]);
  assert.deepEqual(bendPoints(bend, .02).map(p => [Math.round(p.dt * 1000), p.cents]), [[0, 0], [10, 30], [20, -30]]);
  assert.equal(bendPoints({ rate: 1000, cents: new Array(1000).fill(0) }).length, 200);
  assert.deepEqual(bendPoints(null), []);
  const events = attachBends([{ type: 'on', m: 62, t: .5011 }, { type: 'on', m: 64, t: .5 }], [{ t: .5, m: 62, bendRate: 50, bendCents: [10] }]);
  assert.ok(events[0].bend); assert.equal(events[1].bend, undefined);
});

test('note bends are validated', () => {
  const { project, pattern } = fixture();
  pattern.layers[0].events[0].bend = { rate: 100, cents: [5000] };
  assert.throws(() => validateProject(project), /pitch bend/);
});

test('clip fades shape gain, overlapping clips crossfade, and both survive save/load', () => {
  const { clipFades, fadeGainAt } = require('../public/player/project.js');
  const a = { id: 'a', lane: 0, start: 0, length: 4, offsetMs: 0, fadeIn: 1, fadeOut: 0 };
  const b = { id: 'b', lane: 0, start: 3, length: 4, offsetMs: 0, fadeIn: 0, fadeOut: 0 };
  const other = { id: 'c', lane: 1, start: 2, length: 4, offsetMs: 0, fadeIn: 0, fadeOut: 0 };
  const fa = clipFades(a, [a, b, other]), fb = clipFades(b, [a, b, other]);
  assert.deepEqual([fa.fadeIn, fa.fadeOut, fb.fadeIn, fb.fadeOut], [1, 1, 1, 0], 'the 1 s overlap crossfades; other lanes are ignored');
  assert.equal(fadeGainAt(fa, .5), .5); assert.equal(fadeGainAt(fa, 2), 1); assert.equal(fadeGainAt(fa, 3.75), .25);
  assert.ok(Math.abs(fadeGainAt(fa, 3.5) + fadeGainAt(fb, 3.5) - 1) < 1e-9, 'crossfade sums to unity');
  const tight = clipFades({ id: 'd', lane: 0, start: 0, length: 1, offsetMs: 0, fadeIn: 1, fadeOut: 1 });
  assert.equal(tight.fadeIn + tight.fadeOut, 1);
  const { project, clip } = fixture(); clip.fadeIn = .5; clip.fadeOut = .25;
  project.arrangement.markers = [{ id: 'm2', t: 6, name: 'Antara' }, { id: 'm1', t: 1.5, name: 'Sthayi' }];
  const loaded = validateProject(projectData(project));
  assert.equal(loaded.arrangement.clips[0].fadeIn, .5); assert.equal(loaded.arrangement.clips[0].fadeOut, .25);
  assert.deepEqual(loaded.arrangement.markers.map(m => m.name), ['Sthayi', 'Antara']);
  project.arrangement.markers = [{ id: 'm3', t: 999, name: 'x' }];
  assert.throws(() => validateProject(projectData(project)), /marker time/);
});

test('phrase-pad hits keep their hold length through save, load and clip scheduling', () => {
  const project = createProject(), pattern = project.patterns[0]; pattern.lengthSec = 2;
  pattern.layers.push({ id: 'pads', instrumentId: 'bansuri-phrases', flow: 0, choke: false, muted: false,
    events: [{ type: 'hit', t: .25, i: 3, vel: .9, d: .4 }, { type: 'hit', t: 1, i: 1, vel: .7 }] });
  const loaded = validateProject(projectData(project));
  assert.deepEqual(loaded.patterns[0].layers[0].events.map(event => event.d), [.4, undefined]);
  const clip = { id: 'c', kind: 'pattern', ref: pattern.id, lane: 0, start: 3, length: 4, loopLength: 2, trimStart: 0, fadeIn: 0, fadeOut: 0, offsetMs: 0 };
  assert.deepEqual(clipEvents(loaded.patterns[0], clip).map(event => [event.t, event.d]), [[3.25, .4], [4, undefined], [5.25, .4], [6, undefined]]);
  pattern.layers[0].events[0].d = 0;
  assert.throws(() => validateProject(projectData(project)), /hit hold/);
});

test('fitLength loops a played rhythm straight on: one typical gap after the last hit, never a bar of silence', () => {
  const { fitLength } = require('../public/player/project.js');
  const hits = [0, .31, .6, .92].map(t => ({ type: 'hit', t, i: 0, vel: .8 }));
  assert.ok(Math.abs(fitLength([{ events: hits }]) - (.92 + .31)) < 1e-9, 'median gap .31 after the last hit');
  const notes = [{ type: 'on', t: 0, m: 60 }, { type: 'off', t: .4, m: 60 }, { type: 'on', t: .5, m: 62 }, { type: 'off', t: 1.6, m: 62 }];
  assert.equal(fitLength([{ events: notes }]), 1.6, 'a long last note is never cut');
  const held = [{ type: 'hit', t: 0, i: 0, d: 2 }, { type: 'hit', t: .5, i: 1 }];
  assert.equal(fitLength([{ events: held }]), 2, 'a held phrase pad counts to its release');
  assert.equal(fitLength([{ events: [] }]), null);
});

test('piano roll round-trips notes and hits exactly (no grid, bends and holds kept)', () => {
  const { eventsToNotes, notesToEvents } = require('../public/player/project.js');
  const events = [{ type: 'on', t: .1234, m: 60, vel: .7, bend: { rate: 100, cents: [0, 20] } }, { type: 'off', t: .5551, m: 60 },
    { type: 'on', t: .3, m: 64, vel: .5 }, { type: 'off', t: .9, m: 64 }];
  const notes = eventsToNotes(events);
  assert.deepEqual(notes.map(n => [n.t, +n.d.toFixed(4), n.m]), [[.1234, .4317, 60], [.3, .6, 64]]);
  assert.deepEqual(notes[0].bend, { rate: 100, cents: [0, 20] });
  const back = notesToEvents(notes);
  assert.deepEqual(back.map(e => [e.type, +e.t.toFixed(4), e.m]), [['on', .1234, 60], ['on', .3, 64], ['off', .5551, 60], ['off', .9, 64]]);
  const hits = eventsToNotes([{ type: 'hit', t: .25, i: 3, vel: .9, d: .4 }]);
  assert.deepEqual(notesToEvents(hits), [{ type: 'hit', t: .25, i: 3, vel: .9, d: .4 }]);
});

test('live scheduler windows give exactly the same notes, hits and audio as whole-clip scheduling', () => {
  const { windowEvents } = require('../public/player/project.js');
  const { pattern, clip } = fixture();
  pattern.layers.push({ id: 'pads', instrumentId: 'tabla', flow: 0, choke: false, muted: false, events: [{ type: 'hit', t: .25, i: 1, vel: .7 }, { type: 'hit', t: 1.999, i: 2, vel: .5, d: .3 }] });
  const trimmed = { ...clip, start: 3.3, trimStart: .7, length: 5.1, offsetMs: 12 };
  for (const c of [clip, trimmed]) {
    const whole = clipEvents(pattern, c, 90).filter(e => e.type !== 'off');
    const offs = clipEvents(pattern, c, 90).filter(e => e.type === 'off');
    const sliced = [];
    for (let t = 0; t < 12; t += .037) sliced.push(...windowEvents(pattern, c, t, t + .037));
    const key = e => [e.type, +e.t.toFixed(6), e.m ?? e.i, +(e.sourceOffset || 0).toFixed(6)].join();
    assert.deepEqual(sliced.map(key), whole.map(key));
    assert.deepEqual(sliced.filter(e => e.type === 'on').map(e => +e.off.toFixed(6)), offs.map(e => +e.t.toFixed(6)));
  }
  const { pattern: ap, clip: ac } = audioFixture();
  const whole = clipEvents(ap, ac, 90), sliced = [];
  for (let t = 0; t < 12; t += .05) sliced.push(...windowEvents(ap, ac, t, t + .05));
  assert.deepEqual(sliced.map(e => [+e.t.toFixed(6), +e.duration.toFixed(6), +e.sourceOffset.toFixed(6)]), whole.map(e => [+e.t.toFixed(6), +e.duration.toFixed(6), +e.sourceOffset.toFixed(6)]));
  // starting mid-note: includeHeld brings the sounding note in at the start point with the right source offset
  const held = windowEvents(pattern, clip, 4.5, 4.7, { includeHeld: true }).find(e => e.type === 'on');
  assert.equal(+held.t.toFixed(6), 4.5); assert.equal(+held.sourceOffset.toFixed(6), .5); assert.equal(+held.off.toFixed(6), 5.5);
  assert.equal(windowEvents(pattern, clip, 4.5, 4.7).filter(e => e.type === 'on').length, 0);
  // a muted lane schedules nothing
  assert.equal(windowEvents(pattern, clip, 0, 12, { lane: { mute: true } }).length, 0);
});

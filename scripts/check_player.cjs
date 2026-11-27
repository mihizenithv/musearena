// Run with node --test scripts/check_player.cjs. No browser or npm dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const projectCore = require('../public/player/project.js');
const transcriptionCore = require('../public/player/transcription.js');
const effectsCore = require('../public/player/effects.js');

function player() {
  const elements = new Map(), sources = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: ({ flow: '25', rev: '0.16', bpm: '90', bars: '2' })[id] || '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, setAttribute() {}, options: [], appendChild() {},
    });
    return elements.get(id);
  };
  const parameter = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ connect(other) { return other; }, disconnect() {},gain: parameter() });
  class AudioContext {
    constructor() { this.currentTime = 0; this.sampleRate = 100; }
    createAnalyser() { return node(); }
    createGain() { return node(); }
    createStereoPanner() { return {...node(),pan:parameter()}; }
    createBiquadFilter() { return {...node(),frequency:parameter(),Q:parameter()}; }
    createDelay() { return {...node(),delayTime:parameter()}; }
    createConvolver() { return node(); }
    createDynamicsCompressor() { return { ...node(), threshold: {}, ratio: {} }; }
    createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      const source = { ...node(), playbackRate: parameter(), stops: [],
        start(time, offset = 0, duration) { this.startTime = time; this.offset = offset; this.duration = duration; }, stop(time) { this.stops.push(time); } };
      sources.push(source); return source;
    }
    createOscillator() { return { ...this.createBufferSource(), frequency: {} }; }
    resume() {}
  }
  const context = vm.createContext({ console, AudioContext, navigator: {}, ...projectCore, ...transcriptionCore,...effectsCore,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    document: { getElementById: element, addEventListener() {}, querySelectorAll:()=>[], querySelector:()=>null, createElement: () => ({ appendChild() {}, setAttribute() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } }) },
    window: { addEventListener() {} },
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/player/app.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source.slice(0, source.lastIndexOf('\nboot()')) + `
    globalThis.harness = { Instrument, audio, bufferCache, layers, togglePlay, get project() { return project; }, editProject, undo, redo, autosaveNow, songEngines, scheduleStem, playbackPosition,
      recordEvent, liveTake, captureTake, keepIntoBeat, liveLog, set current(value) { current = value; }, get playing() { return playing; },
      get timers() { return transportTimers.size; }, get sounds() { return transportSounds.size; } };
  `, context);
  // These checks cover the audio lifecycle; the real browser checks layer rendering.
  vm.runInContext('renderLayers = () => {};', context);
  const h = context.harness;
  h.audio(); h.bufferCache.set('sample', Promise.resolve({}));
  return { h, elements, sources };
}
const melodic = { kind: 'melodic', notes: { 60: 'sample', 62: 'sample' } };
const pads = { kind: 'pads', pads: [{ files: ['sample'] }] };

test('resuming a pattern at its current position skips elapsed attacks and sustains held content', async () => {
  const { h, sources } = player();
  const inst = new h.Instrument(melodic), pattern = h.project.patterns[0];
  pattern.layers.push({ id: 'seek', def: melodic, inst, flow: 25, muted: false,
    events: [{ type: 'on', m: 60, vel: .7, t: 0 }, { type: 'off', m: 60, t: 4 }] });
  h.project.arrangement.loop.on = false;
  h.project.arrangement.lengthSec = pattern.lengthSec;
  h.project.arrangement.clips.push({ id: 'c', kind: 'pattern', ref: pattern.id, lane: 0, start: 0,
    length: pattern.lengthSec, loopLength: pattern.lengthSec, trimStart: 0, offsetMs: 0 });
  h.togglePlay(false, 2);
  await Promise.all([...h.songEngines.values()].map(engine => engine.queue));
  assert.equal(sources.length, 1); assert.equal(sources[0].offset, 2);
  assert.ok(sources[0].startTime >= 0 && sources[0].startTime < .02);
  assert.ok(Math.abs(h.playbackPosition() - 2) < 1e-9, 'cued at 2 s: the song position is 2 s until it starts');
  h.togglePlay();
});

test('pitched single-note voices compensate measured tuning and wrap long sustained offsets', async () => {
  const { h, sources } = player(); h.bufferCache.set('sample', Promise.resolve({ duration: 2 }));
  const def = { kind: 'melodic', notes: { 60: 'sample' }, tuningCents: { 60: 50 }, sustainLoop: true };
  const inst = new h.Instrument(def);
  await inst.noteOn(60, .7, 0, 25, 5);
  const voice = inst.voices.get(60), rate = Math.pow(2, -.5 / 12);
  assert.equal(sources[0].loop, true);
  assert.ok(Math.abs(voice.rate(60) - rate) < 1e-12);
  assert.ok(Math.abs(sources[0].offset - (5 * rate % 2)) < 1e-12);
});

test('audio stems use source offsets and durations, compensate lateness and stop with transport', () => {
  const { h, sources } = player();
  const layer = { buffer: { duration: 30 } };
  h.scheduleStem(layer, { sourceOffset: 2.5, duration: 4 }, 1);
  assert.equal(sources[0].offset, 2.5); assert.equal(sources[0].duration, 4);
  h.scheduleStem(layer, { sourceOffset: 1, duration: 3 }, -.25);
  assert.equal(sources[1].offset, 1.25); assert.equal(sources[1].duration, 2.75);
  h.scheduleStem(layer, { sourceOffset: 29, duration: 3 }, 1);
  assert.equal(sources[2].duration, 1);
  h.scheduleStem(layer, { sourceOffset: 30, duration: 3 }, 1);
  assert.equal(sources.length, 3);
  h.togglePlay(); h.togglePlay();
  assert.ok(sources.every(source => source.stops.length));
});

test('derived tuneCents corrects sharp and flat samples without snapping played pitch', async () => {
  for (const cents of [-37, 22.5]) {
    const { h } = player();
    const inst = new h.Instrument({ ...melodic, tuneCents: { 60: cents } });
    await inst.noteOn(60, .7, 0, 25);
    assert.ok(Math.abs(inst.voices.get(60).rate(60) - Math.pow(2, -cents / 1200)) < 1e-12);
  }
});
test('a trimmed sustained note resumes at its elapsed sample position', async () => {
  const { h, sources } = player();
  const inst = new h.Instrument(melodic);
  await inst.noteOn(60, .8, 0, 25, .75);
  assert.equal(sources[0].offset, .75);
});

test('a quick release waits for its pending note instead of leaving it sounding', async () => {
  const { h, sources } = player();
  let resolve;
  h.bufferCache.set('sample', new Promise((done) => { resolve = done; }));
  const inst = new h.Instrument(melodic);
  const on = inst.noteOn(60, 0.8, 0, 25);
  const off = inst.noteOff(60, 0.1, 25);
  resolve({}); await Promise.all([on, off]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].stops.length, 1);
  assert.equal(inst.voices.size, 0);
});

test('stopping while a sample loads prevents the pending voice from starting', async () => {
  const { h, sources } = player();
  let resolve;
  h.bufferCache.set('sample', new Promise((done) => { resolve = done; }));
  const inst = new h.Instrument(melodic);
  const pending = inst.noteOn(60, 0.8, 0, 25);
  await Promise.resolve(); inst.allOff(); resolve({}); await pending;
  assert.equal(sources.length, 0);
  assert.equal(inst.held.length, 0);
});

test('all-off cancels pad tails, future notes, and sustained voices', async () => {
  const { h, sources } = player();
  const drum = new h.Instrument(pads);
  await drum.hit(0, 0.8, 20, false);
  const keys = new h.Instrument(melodic);
  await keys.setSustain(true, 25);
  await keys.noteOn(60, 0.8, 20, 25);
  await keys.noteOff(60, 21, 25);
  assert.equal(keys.sustained.size, 1);
  drum.allOff(); keys.allOff();
  assert.equal(keys.sustained.size, 0);
  assert.ok(sources.every((source) => source.stops.at(-1) < 1));
});

test('scheduled note-off follows note-on, and legato releases its final note', async () => {
  const { h, sources } = player();
  const inst = new h.Instrument(melodic);
  await Promise.all([
    inst.noteOn(60, 0.8, 1, 100), inst.noteOn(62, 0.8, 2, 100),
    inst.noteOff(62, 3, 100), inst.noteOff(60, 4, 100),
  ]);
  assert.equal(sources.length, 2);
  assert.ok(sources.every((source) => source.stops.length));
  assert.equal(inst.mono, null);
});

test('changing FLOW while notes are held still releases the earlier polyphonic voice', async () => {
  const { h, sources } = player();
  const inst = new h.Instrument(melodic);
  await inst.noteOn(60, 0.8, 0, 25);
  await inst.noteOn(62, 0.8, 0.2, 100);
  await inst.noteOff(60, 0.3, 100);
  await inst.noteOff(62, 0.4, 100);
  assert.ok(sources.every((source) => source.stops.length));
  assert.equal(inst.voices.size, 0);
});

test('transport stop clears count-in sounds, timers, and timing locks', () => {
  const { h, elements, sources } = player();
  h.togglePlay(true);
  assert.equal(elements.get('bpm').disabled, true);
  assert.ok(sources.length > 0);
  h.togglePlay();
  assert.equal(h.playing, false);
  assert.equal(h.timers, 0); assert.equal(h.sounds, 0);
  assert.equal(elements.get('bars').disabled, false);
  assert.ok(sources.every((source) => source.stops.at(-1) === undefined));
});

test('a key still held when the live take is used gets a release, not a stuck note', () => {
  const { h } = player();
  h.current = { id: 'keys', kind: 'melodic' };
  h.audio().currentTime = 1; h.recordEvent({ type: 'on', m: 60, vel: .7 });
  h.audio().currentTime = 6;
  const events = h.liveTake().layers[0].events;
  assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1))), { type: 'off', t: 5.05, m: 60 });
});
test('new projects use one bar and live capture (no REC) preserves played micro-timing', () => {
  const {h}=player();
  assert.equal(h.project.patterns[0].lengthSec,4*60/h.project.bpm);
  h.current = { id: 'keys', kind: 'melodic' };
  h.audio().currentTime=3.123456;h.recordEvent({type:'on',m:60,vel:.7});
  h.audio().currentTime=3.487654;h.recordEvent({type:'off',m:60});
  h.audio().currentTime=4.000001;h.recordEvent({type:'on',m:64,vel:.5});
  h.audio().currentTime=4.25;h.recordEvent({type:'off',m:64});
  const events = h.liveTake().layers[0].events;
  assert.ok(Math.abs(events[0].t) < 1e-12);
  assert.ok(Math.abs(events[1].t-(3.487654-3.123456))<1e-12, 'release time kept exactly');
  assert.ok(Math.abs(events[2].t-(4.000001-3.123456))<1e-12, 'second note not moved onto a grid');
});
test('dragging the live take onto a lane places it once there, and ADD TO BEAT layers it into the current beat', () => {
  const {h}=player();
  h.current = { id: 'keys', kind: 'melodic' };
  h.audio().currentTime=.1;h.recordEvent({type:'on',m:60,vel:.7});
  h.audio().currentTime=.4;h.recordEvent({type:'off',m:60});
  h.captureTake({ lane: 1, start: 2 });
  assert.equal(h.project.arrangement.clips.length,1);
  assert.equal(h.project.arrangement.clips[0].lane,1);
  assert.equal(h.project.arrangement.clips[0].start,2);
  assert.equal(h.project.arrangement.clips[0].ref,h.project.activePatternId);
  assert.equal(h.liveLog.length, 0, 'the take is used up');
  assert.equal(h.captureTake({ lane: 1, start: 4 }), null);
  assert.equal(h.project.arrangement.clips.length,1);
  h.audio().currentTime=1;h.recordEvent({type:'on',m:62,vel:.7});
  h.audio().currentTime=1.2;h.recordEvent({type:'off',m:62});
  const before = h.project.patterns.find(p => p.id === h.project.activePatternId).layers.length;
  h.keepIntoBeat();
  assert.equal(h.project.patterns.find(p => p.id === h.project.activePatternId).layers.length, before + 1);
});
test('SONG playback respects lane mute, solo, and mute winning over solo', async () => {
  for (const settings of [{mute0:true,solo0:false,solo1:false,count:1}, {mute0:false,solo0:false,solo1:true,count:1}, {mute0:true,solo0:true,solo1:false,count:0}]) {
    const {h,sources}=player(), pattern=h.project.patterns[0];
    pattern.layers.push({id:'layer',def:melodic,flow:25,muted:false,events:[{type:'on',m:60,vel:.8,t:0},{type:'off',m:60,t:.5}]});
    h.project.arrangement.lanes[0].mute=settings.mute0; h.project.arrangement.lanes[0].solo=settings.solo0;
    h.project.arrangement.lanes[1].solo=settings.solo1;
    h.project.arrangement.clips=[0,1].map(lane=>({id:'clip-'+lane,kind:'pattern',ref:pattern.id,lane,start:0,length:1,loopLength:1,trimStart:0,offsetMs:0}));
    h.togglePlay(); await Promise.all([...h.songEngines.values()].map(inst=>inst.queue)); h.togglePlay();
    assert.equal(sources.length,settings.count);
  }
});

test('every edit can be undone and redone, a failed edit changes nothing, and new edits clear redo', () => {
  const { h } = player();
  const clip = (id, start) => ({ id, kind: 'pattern', ref: h.project.patterns[0].id, lane: 0, start, length: 1, loopLength: 1, trimStart: 0, offsetMs: 0, fadeIn: 0, fadeOut: 0 });
  h.editProject(p => { p.arrangement.clips.push(clip('a', 0)); });
  h.editProject(p => { p.arrangement.clips[0].start = 3; });
  h.editProject(p => { p.arrangement.clips.push(clip('b', 5)); });
  assert.deepEqual(h.project.arrangement.clips.map(c => [c.id, c.start]), [['a', 3], ['b', 5]]);
  h.undo(); assert.deepEqual(h.project.arrangement.clips.map(c => [c.id, c.start]), [['a', 3]]);
  h.undo(); assert.equal(h.project.arrangement.clips[0].start, 0, 'a clip move is undoable');
  h.redo(); assert.equal(h.project.arrangement.clips[0].start, 3);
  assert.throws(() => h.editProject(p => { p.arrangement.clips[0].start = 99; throw new Error('no room'); }));
  assert.equal(h.project.arrangement.clips[0].start, 3, 'a failed edit is rolled back');
  h.editProject(p => { p.name = 'New'; });
  assert.equal(h.redo(), false, 'a new edit clears the redo history');
  h.undo(); h.undo(); h.undo(); assert.equal(h.project.arrangement.clips.length, 0);
  assert.equal(h.undo(), false, 'nothing left to undo');
});
test('undo keeps the loaded instruments: a restored layer still has its instrument and engine', () => {
  const { h } = player();
  const inst = new h.Instrument(melodic);
  h.editProject(p => { p.patterns[0].layers.push({ id: 'L', def: melodic, inst, flow: 25, muted: false, events: [{ type: 'on', m: 60, vel: .8, t: 0 }, { type: 'off', m: 60, t: .5 }] }); });
  h.editProject(p => { p.patterns[0].layers[0].events[0].t = .25; });
  h.undo();
  const layer = h.project.patterns[0].layers[0];
  assert.equal(layer.inst, inst); assert.equal(layer.def, melodic); assert.equal(layer.events[0].t, 0);
});

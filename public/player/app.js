// MuseArena Player — audition every instrument in the library and sketch loops.
// Plain ES module, no build step. Served from the project root (see .claude/launch.json).
import { createProject, newId, clipEvents, windowEvents, projectData, validateProject, bendPoints, clipFades, fitLength } from "./project.js";
import { encodeMidi, encodeWav, notesFromEvents } from "./midi.js";
import { mountArrangement } from "./arrangement.js";

import { patternFromTranscription, generatedLayer, revoicedEvents } from "./transcription.js";
import { mountDock } from "./dock.js";
import { mountHum } from "./hum.js";
import { createEffectsGraph, defaultFx } from "./effects.js";
import { mountInspector } from "./inspector.js";
import { mountLibrary, rememberProject } from "./studio-library.js";
import { mountVisuals } from "./visuals.js";
import { mountBeatMaker } from "./beatmaker.js";
import { mountViews } from "./views.js";
import { mountPianoRoll } from "./pianoroll.js";
import { mountStepGrid } from "./stepgrid.js";
import { mountChrome, mountRangeFill, mountTuneStrip } from "./chrome.js";

const $ = (id) => document.getElementById(id);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

// ---------------------------------------------------------------- audio core
let ctx, master, reverbSend, liveOutput;
function attachOutputMeter(context, output) {
  const meter = $("mixLevel"), peak = context.createAnalyser();
  peak.fftSize = 2048;
  output.connect(peak);
  const samples = new Float32Array(peak.fftSize);
  let previous = 0;
  function update(now) {
    if (now - previous >= 40) {
      peak.getFloatTimeDomainData(samples);
      let amplitude = 0;
      for (const sample of samples) amplitude = Math.max(amplitude, Math.abs(sample));
      const db = Math.max(-60, Math.min(0, 20 * Math.log10(amplitude)));
      meter.value = Math.max(db, meter.value - (now - previous) * .045);
      previous = now;
    }
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}
function audio() {
  if (ctx) return ctx;
  ctx = new AudioContext({ latencyHint: "interactive" });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10; comp.ratio.value = 3;
  master = ctx.createGain(); master.gain.value = 0.8;
  const conv = ctx.createConvolver(); conv.buffer = impulse(2.4);
  reverbSend = ctx.createGain(); reverbSend.gain.value = +$("rev").value;
  master.connect(comp); master.connect(reverbSend).connect(conv).connect(comp);
  liveOutput = ctx.createGain();
  comp.connect(liveOutput).connect(ctx.destination);
  attachOutputMeter(ctx, liveOutput);
  return ctx;
}
// Browser preview players have their own volume controls. Join them after compression.
for (const id of ["stemPreview", "voicePlayback"]) {
  const preview = $(id);
  let source;
  preview.addEventListener("play", () => {
    const context = audio();
    if (context !== liveOutput.context) return;
    if (!source) {
      source = context.createMediaElementSource(preview);
      source.connect(liveOutput);
    }
    if (context.state === "suspended") context.resume().catch(() => {});
  });
}
function impulse(sec) {
  const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3; }
  return b;
}

const bufferCache = new Map();
const effectBuses = new Map();
function effectBus(key, resolve) {
  audio();
  if (!effectBuses.has(key)) effectBuses.set(key, {graph:createEffectsGraph(ctx,master,resolve(),project.bpm),resolve});
  const bus=effectBuses.get(key);bus.graph.update(bus.resolve(),project.bpm);return bus.graph.input;
}
function laneOutput(index) {const lane=project.arrangement.lanes[index]||project.arrangement.lanes[0];return effectBus('lane:'+lane.id,()=>({...defaultFx(),...lane.fx}));}
function clipOutput(clip) {return clip.fx?effectBus('clip:'+clip.id,()=>({...defaultFx(),...project.arrangement.lanes[clip.lane].fx,...clip.fx})):laneOutput(clip.lane);}
// Clip fade / crossfade envelope in front of the clip's FX bus. toTime maps song seconds to context time.
const clipFadeNodes = new Map();
function fadeInput(context, clip, toTime, output) {
  const f = clipFades(clip, project.arrangement.clips);
  if (!f.fadeIn && !f.fadeOut) return output;
  const g = context.createGain(); g.connect(output);
  const s = toTime(f.start), e = toTime(f.end);
  g.gain.setValueAtTime(f.fadeIn ? 0 : 1, Math.max(0, s));
  if (f.fadeIn) g.gain.linearRampToValueAtTime(1, Math.max(0, s + f.fadeIn));
  if (f.fadeOut) { g.gain.setValueAtTime(1, Math.max(0, e - f.fadeOut)); g.gain.linearRampToValueAtTime(0, Math.max(0, e)); }
  return g;
}
function playerOutput() {
  const selection=arrangementUI?.getSelection();
  return selection?.clip?.ref===activePattern.id?clipOutput(selection.clip):laneOutput(recordingLane??selection?.lane??0);
}
function applyEffects() {effectBuses.forEach(bus=>bus.graph.update(bus.resolve(),project.bpm));}
function clearEffects() {effectBuses.forEach(bus=>bus.graph.dispose());effectBuses.clear();}
function encodePath(p) { return "../" + p.split("/").map(encodeURIComponent).join("/"); }
function loadBuffer(path) {
  if (!bufferCache.has(path)) {
    // one retry on a network error: a burst of many sample requests can lose a connection
    const get = () => path.startsWith("output/imports/") ? caches.open("musearena-imports-v1").then(store => store.match("/" + path)) : fetch(encodePath(path)).catch(() => new Promise(resolve => setTimeout(resolve, 150)).then(() => fetch(encodePath(path))));
    bufferCache.set(path, get()
      .then((r) => { if (!r.ok) throw new Error(r.status + " " + path); return r.arrayBuffer(); })
      .then((a) => audio().decodeAudioData(a))
      .catch((e) => { console.warn("load failed", e); bufferCache.delete(path); return null; }));
  }
  return bufferCache.get(path);
}

// ---------------------------------------------------------------- flow macro
// Sample-oriented approximation of Flow Lab: 0 = sharp, 100 = sung.
function flowParams(v) {
  const pts = [
    { attack: 2, release: 30, glide: 0, xfade: 0, legato: false },
    { attack: 6, release: 400, glide: 0, xfade: 0, legato: false },
    { attack: 15, release: 500, glide: 0, xfade: 80, legato: true },
    { attack: 30, release: 650, glide: 120, xfade: 120, legato: true },
    { attack: 70, release: 900, glide: 190, xfade: 160, legato: true },
  ];
  const pos = Math.min(v / 25, 3.999), i = Math.floor(pos), f = pos - i, a = pts[i], b = pts[i + 1];
  const mix = (k) => Math.round(a[k] + (b[k] - a[k]) * f);
  return { attack: mix("attack"), release: mix("release"), glide: mix("glide"), xfade: mix("xfade"), legato: f >= 0.5 ? b.legato : a.legato };
}
const tc = (ms) => Math.max(ms, 1) / 3000; // setTargetAtTime constant → ~95% after ms

// ---------------------------------------------------------------- instrument engine
const PHRASE_SECONDS = 2.5;
class Instrument {
  constructor(def, output = () => master) {
    this.def = def;
    this.output = output;
    this.voices = new Map();   // midi -> voice (melodic)
    this.mono = null;          // current legato voice
    this.held = [];
    this.sustain = false; this.sustained = new Set();
    this.rr = new Map();       // pad -> round-robin index
    this.lastPadVoice = null;
    this.activeVoices = new Set();
    this.queue = Promise.resolve();
    this.generation = 0;
    if (def.kind === "melodic") {
      this.roots = Object.keys(def.notes).map(Number).sort((a, b) => a - b);
    }
  }
  async load(onProgress) {
    const paths = this.def.kind === "melodic" ? Object.values(this.def.notes) : this.def.pads.map((p) => p.files[0]);
    let done = 0, total = paths.length;
    const get = (p) => loadBuffer(p).then((buffer) => { onProgress?.(++done, total); return buffer; });
    const results = await Promise.all(paths.map(get));
    let failed = results.filter((buffer) => !buffer).length;
    // Every variation of a short (stroke) pad is loaded now, so round-robin hits are never late the first time
    // (BUGS.md C2). Long phrase recordings keep loading on demand to save memory.
    if (this.def.kind !== "melodic") {
      const extra = this.def.pads.flatMap((pad, i) => results[i] && results[i].duration <= PHRASE_SECONDS ? pad.files.slice(1) : []);
      total += extra.length;
      failed += (await Promise.all(extra.map(get))).filter((buffer) => !buffer).length;
    }
    return failed;
  }
  enqueue(action) {
    // Preserve on/off order across sample loads; allOff invalidates pending work.
    const generation = this.generation;
    this.queue = this.queue.then(() => generation === this.generation ? action() : undefined)
      .catch((error) => console.warn("playback failed", error));
    return this.queue;
  }
  trackVoice(voice) {
    this.activeVoices.add(voice);
    voice.src.onended = () => this.activeVoices.delete(voice);
    return voice;
  }
  nearestRoot(m) {
    let best = this.roots[0];
    for (const r of this.roots) if (Math.abs(r - m) < Math.abs(best - m)) best = r;
    return best;
  }
  async makeVoice(midi, vel, t, fromMidi = null, flow, sourceOffset = 0, bend = null) {
    const generation = this.generation;
    const root = this.nearestRoot(midi);
    const buf = await loadBuffer(this.def.notes[root]);
    if (!buf || generation !== this.generation) return null;
    const src = ctx.createBufferSource(); src.buffer = buf;
    src.loop = !!this.def.sustainLoop;
    const rate = (m) => Math.pow(2, (m - root - (this.def.tuneCents?.[root] ?? this.def.tuningCents?.[root] ?? 0) / 100) / 12);
    let offset = sourceOffset * rate(midi);
    if (this.def.sustainLoop && buf.duration) offset %= buf.duration;
    else if (Number.isFinite(buf.duration) && offset >= buf.duration) return null;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(g).connect(this.output());
    const when = Math.max(t, ctx.currentTime);
    const curve = bendPoints(bend, sourceOffset);
    if (curve.length) {
      // Transcribed meend/vibrato: the recorded pitch curve replaces the FLOW glide for this note.
      const at = (cents) => rate(midi) * Math.pow(2, cents / 1200);
      src.playbackRate.setValueAtTime(at(curve[0].cents), when);
      for (const point of curve.slice(1)) src.playbackRate.linearRampToValueAtTime(at(point.cents), when + point.dt);
    } else if (fromMidi !== null && flow.glide > 0) {
      src.playbackRate.setValueAtTime(rate(fromMidi), when);
      src.playbackRate.setTargetAtTime(rate(midi), when, tc(flow.glide));
    } else src.playbackRate.setValueAtTime(rate(midi), when);
    const fadeIn = fromMidi !== null ? Math.max(flow.xfade, flow.attack) : flow.attack;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vel, when + fadeIn / 1000);
    src.start(when, offset);
    return this.trackVoice({ src, g, midi, rate, root });
  }
  release(v, t, ms) {
    if (!v) return;
    const when = Math.max(t, ctx.currentTime);
    v.g.gain.cancelScheduledValues(when);
    v.g.gain.setTargetAtTime(0, when, tc(ms));
    try { v.src.stop(when + ms / 1000 * 1.5 + 0.05); } catch {}
  }
  noteOn(midi, vel, t, flowValue, sourceOffset = 0, bend = null) {
    return this.enqueue(async () => {
      audio();
      const flow = flowParams(flowValue);
      if (this.def.kind !== "melodic") return;
      this.held = this.held.filter((m) => m !== midi).concat(midi);
      if (flow.legato && this.mono) {
        // legato: glide from the sounding note into the new one, crossfading samples
        const old = this.mono;
        const v = await this.makeVoice(midi, vel, t, old.midi, flow, sourceOffset, bend);
        if (!v) return;
        if (flow.glide > 0 && !bend) old.src.playbackRate.setTargetAtTime(old.rate(midi), Math.max(t, ctx.currentTime), tc(flow.glide));
        this.release(old, t, Math.max(flow.xfade, 20));
        this.mono = v;
        return;
      }
      if (this.voices.has(midi)) this.release(this.voices.get(midi), t, 30);
      const v = await this.makeVoice(midi, vel, t, null, flow, sourceOffset, bend);
      if (!v) return;
      if (flow.legato) this.mono = v; else this.voices.set(midi, v);
    });
  }
  noteOff(midi, t, flowValue) {
    return this.enqueue(() => this.releaseNote(midi, t, flowValue));
  }
  releaseNote(midi, t, flowValue) {
    if (this.def.kind !== "melodic") return;
    const flow = flowParams(flowValue);
    this.held = this.held.filter((m) => m !== midi);
    const voice = this.voices.get(midi);
    if (voice) {
      this.voices.delete(midi);
      if (this.sustain) this.sustained.add(voice); else this.release(voice, t, flow.release);
    }
    if (this.mono) {
      if (this.held.length && this.mono.midi === midi) {
        // fall back to the still-held note, like a singer returning to it
        const back = this.held[this.held.length - 1];
        const when = Math.max(t, ctx.currentTime);
        this.mono.src.playbackRate.setTargetAtTime(this.mono.rate(back), when, tc(flow.glide));
        this.mono.midi = back;
        this.held = this.held.filter((m) => m !== back).concat(back);
        return;
      }
      if (!this.held.length) {
        if (this.sustain) { this.sustained.add(this.mono); }
        else this.release(this.mono, t, flow.release);
        this.mono = null;
      }
      return;
    }
  }
  setSustain(on, flowValue) {
    return this.enqueue(() => {
      this.sustain = on;
      if (!on && ctx) { const r = flowParams(flowValue).release; this.sustained.forEach((v) => this.release(v, ctx.currentTime, r)); this.sustained.clear(); }
    });
  }
  // Many library "pads" are whole recorded phrases (4-160 s), not strokes. Those are gated like a held note:
  // they sound while the pad is held (or for the recorded hold `hold`), and a new phrase cuts the previous one.
  isPhrase(index) { return this.phrasePads?.has(index); }
  releasePad(index, t) {
    return this.enqueue(() => { const voice = this.padVoices?.get(index); if (voice && this.isPhrase(index)) { this.release(voice, t, 120); this.padVoices.delete(index); } });
  }
  hit(index, vel, t, choke, hold = null, gateAlways = false) {
    return this.enqueue(async () => {
      const generation = this.generation;
      audio();
      const pad = this.def.pads[index];
      if (!pad) return;
      const i = (this.rr.get(index) || 0) % pad.files.length;
      this.rr.set(index, i + 1);
      const buf = await loadBuffer(pad.files[i]);
      if (!buf || generation !== this.generation) return;
      const when = Math.max(t, ctx.currentTime), phrase = buf.duration > PHRASE_SECONDS;
      this.phrasePads ??= new Set(); this.padVoices ??= new Map();
      if (phrase) this.phrasePads.add(index);
      if ((choke || phrase) && this.lastPadVoice) this.release(this.lastPadVoice, when, phrase ? 80 : 25);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain(); g.gain.value = vel;
      src.connect(g).connect(this.output()); src.start(when);
      this.lastPadVoice = this.trackVoice({ src, g });
      this.padVoices.set(index, this.lastPadVoice);
      if (hold && (phrase || gateAlways)) this.release(this.lastPadVoice, when + hold, 120);
    });
  }
  allOff() {
    this.generation++;
    if (ctx) this.activeVoices.forEach((v) => this.release(v, ctx.currentTime, 60));
    this.voices.clear(); this.sustained.clear(); this.sustain = false;
    this.mono = null; this.held = []; this.lastPadVoice = null;
  }
}

// ---------------------------------------------------------------- library UI
let library = [], current = null, currentInst = null, activeCat = "All", artMap = {};
const flowValue = () => +$("flow").value;

// Generated instrument art (scripts/gen_art.py): match keywords, fall back per category.
const CATEGORY_ART = { "Indian": "tanpura", "Drums & Percussion": "drums", "Keys": "piano", "Strings": "violin", "Winds": "flute",
  "World": "kalimba", "Voice & Pads": "voice", "Textures": "vinyl", "Other": "synth" };
function artFor(def, thumb = false) {
  const text = " " + (def.name + " " + def.path).toLowerCase().replace(/[_\-/,·.]+/g, " ") + " ";
  let slug = Object.keys(artMap).find((s) => artMap[s].keywords.some((k) => text.includes(" " + k.replace(/[_\-]+/g, " "))));
  slug = slug || CATEGORY_ART[def.category];
  const a = artMap[slug];
  return a ? (thumb ? a.thumb : a.file) : "";
}
const setBtn = (el, icon, label) => { el.innerHTML = `<svg class="i"><use href="#i-${icon}"/></svg><span>${label}</span>`; };

async function boot() {
  mountVisuals(); mountChrome(); mountRangeFill();
  try { artMap = await (await fetch("assets/art/art.json")).json(); } catch { artMap = {}; }
  const res = await fetch("../library/index.json");
  if (!res.ok) { $("status").textContent = "library/index.json not found — run: python -I scripts/build_index.py"; return; }
  const curated = await fetch("assets/voices/index.json");
  if (!curated.ok) throw new Error("Pitched voice catalogue is unavailable");
  library = (await res.json()).instruments;
  for (const voice of (await curated.json()).instruments) {
    const sourceIndex = library.findIndex(instrument => instrument.path === voice.path);
    library.splice(sourceIndex < 0 ? library.length : sourceIndex + 1, 0, voice);
  }
  arrangementUI = mountArrangement({ getProject: () => project, onEdit: editProject, onUndo: () => undo(),
    onSelection: () => inspectorUI?.render(),
    onPatternSelect: selectRecordingTarget,
    // In the Timeline view a double-clicked clip opens the piano roll; Overview keeps opening the player.
    onOpenPattern: (id, lane) => { if (viewsUI?.get() === "timeline") { selectRecordingTarget(id, lane); rollUI?.open(id); rollFocus(); } else selectRecordingTarget(id, lane); },
    onSave: saveProject, onLoad: loadProject, onJump: jumpTo, onDropFiles: importFiles, onDropTake: (lane, start) => captureTake({ lane, start }) });
  beatUI = mountBeatMaker({ getPattern: () => activePattern, getState: beatState,
    onPlay: () => { if (playing && playbackMode === "pattern") return togglePlay(); if (playbackMode !== "pattern") setPlaybackMode("pattern"); else if (playing) togglePlay(); togglePlay(); },
    onHum: () => $("humBtn").click(), onCapture: () => keepIntoBeat(), onClearLive: () => { stopLivePreview(); liveLog.length = 0; beatUI.render(); },
    onPlayLive: () => playLiveTake(), onToggleArm: () => { liveArmed = !liveArmed; beatUI.render(); $("status").textContent = liveArmed ? "Capturing: whatever you play goes into the live take." : "Capture paused: play freely, nothing is kept."; },
    onNew: () => { setPlaybackMode("pattern"); $("newPattern").click(); $("status").textContent = inStepMode() ? "New empty beat: click steps to place hits." : "New empty beat: just play, then ADD TO BEAT."; },
    onToTimeline: () => addBeatToTimeline() });
  $("importAudio").onclick = () => $("audioFile").click();
  $("audioFile").onchange = async event => { const files = [...event.target.files]; event.target.value = ""; const sel = arrangementUI?.getSelection(); await importFiles(files, sel?.lane ?? 0, 0 + Math.max(0, ...project.arrangement.clips.filter(clip => clip.lane === (sel?.lane ?? 0)).map(clip => clip.start + clip.length))); };
  let panelWasOpen = null; // the AI view opens the generator; leaving it puts the panel back as it was, so Overview never changes
  viewsUI = mountViews({ onChange: view => {
    if (view === "ai") { if (panelWasOpen === null) panelWasOpen = $("generatePanel").open; $("generatePanel").open = true; }
    else if (panelWasOpen !== null) { $("generatePanel").open = panelWasOpen; panelWasOpen = null; }
    if (view === "beat") dockUI?.expand(true);                     // the beat maker needs the player open
    beatUI?.render(); arrangementUI?.render(); stepUI?.render();
  } });
  rollUI = mountPianoRoll({ getProject: () => project, onEdit: mutation => { rollCommitting = true; try { editProject(mutation); } finally { rollCommitting = false; } }, getBpm: () => +$("bpm").value || 90,
    getInstrument: layer => layer?.def || library.find(item => item.id === layer?.instrumentId),
    onPreview: (layer, value, vel = .8) => {
      const def = layer?.def || library.find(item => item.id === layer?.instrumentId); if (!def) return;
      audio(); ctx.resume();
      if (!previewEngine || previewEngine.def !== def) { previewEngine?.allOff(); previewEngine = new Instrument(def, () => laneOutput(0)); }
      if (def.kind === "melodic") { previewEngine.noteOn(value, vel, ctx.currentTime, layer.flow); previewEngine.noteOff(value, ctx.currentTime + .35, layer.flow); }
      else previewEngine.hit(value, vel, ctx.currentTime, false, .6, true);
    } });
  stepUI = mountStepGrid({ getPattern: () => activePattern, getCurrent: () => current, getBpm: () => +$("bpm").value || 90,
    getVelocity: () => +$("vel").value, getOctave: () => octave, onEdit: editProject,
    getInstrument: id => library.find(item => item.id === id),
    onPreview: (row, vel) => {
      const def = library.find(item => item.id === row.instrumentId); if (!def) return;
      audio(); ctx.resume();
      if (!previewEngine || previewEngine.def !== def) { previewEngine?.allOff(); previewEngine = new Instrument(def, () => laneOutput(0)); }
      if (row.pads) previewEngine.hit(row.value, vel, ctx.currentTime, false, .6, true);
      else { previewEngine.noteOn(row.value, vel, ctx.currentTime, 0); previewEngine.noteOff(row.value, ctx.currentTime + .25, 0); }
    } });
  // Beat Maker tab: LIVE (play and record) or STEP GRID (place hits exactly), never both. Overview is always live.
  $("modeLive").onclick = () => setBeatMode("live");
  $("modeStep").onclick = () => setBeatMode("step");
  for (const id of ["modeLive", "modeStep"]) $(id).onkeydown = event => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setBeatMode(beatMode === "live" ? "step" : "live"); $(beatMode === "live" ? "modeLive" : "modeStep").focus(); }
  };
  let savedMode = "live"; try { if (localStorage.getItem("musearena.beatMode") === "step") savedMode = "step"; } catch {}
  setBeatMode(savedMode, false);
  // AI view: hum to tune, with its own instrument choice (the player is hidden in that view)
  $("aiHumInstrument").replaceChildren(...library.filter(item => item.kind === "melodic").map(item => {
    const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; return option;
  }));
  $("aiHumInstrument").onchange = () => { const def = library.find(item => item.id === $("aiHumInstrument").value); if (def) select(def, false); };
  $("aiHum").onclick = () => {
    if (current?.kind !== "melodic") { const def = library.find(item => item.id === $("aiHumInstrument").value); if (def) select(def, false); }
    $("humBtn").click();
  };
  new MutationObserver(() => {
    $("aiHumStatus").textContent = $("humStatus").textContent;
    const on = $("humBtn").getAttribute("aria-pressed") === "true";
    $("aiHum").setAttribute("aria-pressed", String(on)); $("aiHum").querySelector("span").textContent = on ? "STOP HUM" : "HUM A TUNE";
    $("aiHum").disabled = $("humBtn").disabled;
  }).observe($("humBtn"), { subtree: true, attributes: true, childList: true, characterData: true });
  new MutationObserver(() => { $("aiHumStatus").textContent = $("humStatus").textContent; }).observe($("humStatus"), { childList: true, characterData: true, subtree: true });
  $("clipReverse").onclick = () => editAudioClip("reverse");
  $("clipStretchApply").onclick = () => editAudioClip("stretch");
  // Note editing: the piano roll lives in the full-screen Timeline view, so from Overview this switches there first.
  $("openRoll").onclick = () => {
    const id = arrangementUI?.getSelection().clip?.ref || project.activePatternId;
    const pattern = project.patterns.find(item => item.id === id);
    // A beat with nothing recorded yet still gets a piano roll: an empty layer on the player's instrument, so notes
    // can be written by hand (double-click to add). Before, the roll refused and there was no way to write notes.
    if (pattern && !pattern.layers.some(layer => layer.kind !== "audio")) {
      if (!current) { $("status").textContent = "Pick an instrument on the left first, then NOTES to write notes for it."; return; }
      if (pattern.layers.length >= 64) { $("status").textContent = "This beat already has the maximum number of layers"; return; }
      editProject(() => { pattern.layers.push({ id: newId(), instrumentId: current.id, flow: flowValue(), choke: $("choke").checked, muted: false, events: [] }); });
      $("status").textContent = `New ${current.name} layer: double-click in the piano roll to add notes.`;
    }
    if (viewsUI?.get() !== "timeline") viewsUI?.set("timeline");
    rollUI.open(id); rollFocus();
  };
  $("exportMidi").onclick = () => exportMidi();
  $("exportWav").onclick = () => exportWav().catch(() => {});
  syncProjectUI();
  inspectorUI = mountInspector({ getTarget: () => {
    const selection=arrangementUI.getSelection(),lane=project.arrangement.lanes[selection.lane]||project.arrangement.lanes[0];
    return {lane,clip:selection.clip,name:project.patterns.find(pattern=>pattern.id===selection.clip?.ref)?.name||lane.name};
  }, getBpm:()=>project.bpm,onChange:applyEffects });
  dockUI = mountDock({ onResize: () => requestAnimationFrame(() => changeOctave(0)) });
  $("status").textContent = `${library.length} instruments`;
  const cats = ["All", ...new Set(library.map((i) => i.category))];
  $("cats").innerHTML = "";
  cats.forEach((c) => {
    const b = document.createElement("button"); b.dataset.cat = c;
    const n = c === "All" ? library.length : library.filter((i) => i.category === c).length;
    b.innerHTML = `<span></span><span class="n">${n}</span>`; b.firstChild.textContent = c;
    b.onclick = () => { activeCat = c; renderList(); };
    $("cats").appendChild(b);
  });
  renderList();
  const pickerIds = new Set();
  $("playerInstrument").replaceChildren(...library.filter(instrument => {
    if (pickerIds.has(instrument.id)) return false; pickerIds.add(instrument.id); return true;
  }).map(instrument => {
    const option = document.createElement("option"); option.value = instrument.id; option.textContent = instrument.name + (instrument.kind === "melodic" ? "" : " · pads"); return option;
  }));
  $("playerInstrument").onchange = async event => {
    const instrument = library.find(instrument => instrument.id === event.target.value), layer = generatedLayer(activePattern);
    try {
      if (layer && (instrument.kind === "melodic") !== layer.events.some(event => event.type === "hit")) await revoiceGeneratedPattern(instrument.id, [0,1,2].map(i => Math.min(i, (instrument.pads?.length || 1) - 1)));
      else await select(instrument, true);
    } catch (error) { $("status").textContent = error.message; }
  };
  const first = library.find((i) => /sitar/i.test(i.name) && i.kind === "melodic") || library.find(i => i.name.includes("Upright")) || library[0];
  if (first) select(first, false);
  // reopen the last session (autosave); a project that can't be restored leaves a fresh one
  let saved = null; try { saved = localStorage.getItem(AUTOSAVE_KEY); } catch {}
  if (saved) await loadProjectText(saved, { restored: true });
  humUI = mountHum({ getTarget: () => ({ instrument: current, project, lane: recordingLane, bpm: +$("bpm").value || 90 }),
    onShow: () => dockUI.expand(true),
    onStart: () => { if (playing) togglePlay(); $("stemPreview").pause(); originalGeneration++; currentInst?.allOff(); openPatternEditor(); },
    onState: state => { humming = state !== "idle"; beatUI?.render(); document.querySelector(".hum-panel").classList.toggle("active", humming);
      $("playerInstrument").disabled = humming; document.querySelector('.lib').inert = humming;  },
    onResult: async (result, target) => {
      if (project !== target.project) throw new Error("Project changed; your recording was saved, but the current project was kept.");
      if (!result.events?.length) { generatorUI.showHum({ kind: "hum", url: result.audioUrl }); return null; }
      return addGeneratedPattern({ audioUrl: result.audioUrl, transcription: result }, {
        role: "hum", model: "hum", mono: true, genre: "Hummed", instrumentId: target.instrument.id,
        targetLane: target.lane, isCurrent: target.isCurrent });
    },
    onVoice: async file => {
      setVoicePreview(file);
      const selected = arrangementUI.getSelection();
      return importAudio(file, selected.lane, arrangementUI.getCursor());
    } });
  $("voiceImport").onclick = () => $("voiceFile").click();
  $("voiceFile").onchange = async event => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file) return;
    const pattern = await importAudio(file, arrangementUI.getSelection().lane, arrangementUI.getCursor());
    if (pattern) { setVoicePreview(file); $("voicePlayback").hidden = false; }
  };
  mountLibrary({ snapshot: () => projectData(project), create: createProject, load: loadProjectText,
    pause: () => { if (humming) humUI?.cancel(); stopLivePreview(); if (playing) togglePlay(); $("voicePlayback").pause(); },
    enter: () => { sessionStorage.setItem("musearena.studioEntered","1"); viewsUI.set("beat"); }
  });
}

function setVoicePreview(file) {
  const player = $("voicePlayback");
  if (player.src.startsWith("blob:")) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(file);
  player.hidden = false;
}

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  [...$("cats").children].forEach((b) => {
    b.classList.toggle("on", b.dataset.cat === activeCat);
    b.setAttribute("aria-pressed", String(b.dataset.cat === activeCat));
  });
  const items = library.filter((i) => (activeCat === "All" || i.category === activeCat) &&
    (!q || (i.name + " " + i.path + " " + i.category).toLowerCase().includes(q)));
  const list = $("list"); list.innerHTML = "";
  let cat = null;
  for (const i of items) {
    if (i.category !== cat) { cat = i.category; const h = document.createElement("h3"); h.textContent = cat; list.appendChild(h); }
    const d = document.createElement("button"); d.type = "button";
    d.className = "item" + (current === i ? " sel" : "");
    d.setAttribute("aria-pressed", String(current === i));
    const count = i.kind === "melodic" ? `${noteName(i.range[0])}–${noteName(i.range[1])}` : `${i.pads.length} PADS`;
    d.innerHTML = `<span class="nm"></span><span class="k">${count}</span>`;
    const src = artFor(i, true);
    if (src) { const img = document.createElement("img"); img.loading = "lazy"; img.alt = ""; img.src = src; d.prepend(img); }
    d.querySelector(".nm").textContent = i.name;
    d.onclick = () => select(i, true);
    list.appendChild(d);
  }
  if (!items.length) {
    const empty = document.createElement("p"); empty.className = "hint empty";
    empty.textContent = "No instruments match your search."; list.appendChild(empty);
  }
}
$("search").oninput = renderList;

async function select(def, preview) {
  current = def; renderList();
  if (def.kind === "melodic" && [...$("aiHumInstrument").options].some(option => option.value === def.id)) $("aiHumInstrument").value = def.id;
  $("playerInstrument").value = def.id;
  currentInst?.allOff();
  downKeys.clear(); mouseNote = null;
  const inst = new Instrument(def,playerOutput); currentInst = inst;
  $("instName").textContent = def.name;
  $("instCat").textContent = `${def.category} · ${def.kind === "melodic" ? "keyboard" : "pads"}`;
  $("instArt").src = artFor(def) || "";
  const nc = /NC|unstated|unknown|\?/i.test(def.license);
  $("instMeta").innerHTML = `<span class="${nc ? "nc" : ""}"></span><a target="_blank" rel="noreferrer"></a>`;
  $("instMeta").children[0].textContent = $("instMeta").children[0].title = def.license;
  const a = $("instMeta").querySelector("a"); a.textContent = a.title = def.source; a.href = def.sourceUrl || "#";
  document.body.classList.toggle("melodic", def.kind === "melodic");
  document.body.classList.toggle("pads", def.kind !== "melodic");
  $("keyboardView").classList.toggle("show", def.kind === "melodic");
  $("padsView").classList.toggle("show", def.kind !== "melodic");
  $("flowBox").style.visibility = def.kind === "melodic" ? "visible" : "hidden";
  if (def.kind === "melodic") {
    const mid = Math.round((def.range[0] + def.range[1]) / 2);
    octave = Math.max(1, Math.min(7, Math.floor(mid / 12) - 1));
    $("octVal").textContent = octave;
    buildPiano(def);
  } else buildPads(def);
  if (preview) openPatternEditor();
  $("status").textContent = "loading samples…";
  const failed = await inst.load((d, n) => { if (currentInst === inst) $("status").textContent = `loading ${d}/${n}`; });
  if (currentInst !== inst) return;
  $("status").textContent = failed ? `${failed} samples unavailable — try another instrument` : `${def.name} ready`;
  if (preview && ctx) {
    if (def.kind === "melodic") {
      const m = inst.nearestRoot(60);
      inst.noteOn(m, 0.7, ctx.currentTime, flowValue());
      setTimeout(() => inst.noteOff(m, ctx.currentTime, flowValue()), 450);
    } else inst.hit(0, 0.8, ctx.currentTime, false, PREVIEW_SECONDS, true); // clicking an instrument only tastes it, never plays a whole recording
  }
}
const PREVIEW_SECONDS = 1;

// ---------------------------------------------------------------- piano
let octave = 4;
const KEYROW = "awsedftgyhujkolp;".split("");   // C .. E (next octave)
const keyEls = new Map();
function buildPiano(def) {
  const piano = $("piano"); piano.innerHTML = ""; keyEls.clear();
  const lo = 24, hi = 108; // C1..C8
  let x = 0;
  const roots = new Set(Object.keys(def.notes).map(Number));
  for (let m = lo; m <= hi; m++) {
    const black = [1, 3, 6, 8, 10].includes(m % 12);
    const el = document.createElement("button"); el.type = "button";
    el.setAttribute("aria-label", noteName(m));
    el.className = black ? "bk" : "wk";
    if (m < def.range[0] - 12 || m > def.range[1] + 12) el.classList.add("out");
    if (black) el.style.left = (x - 11) + "px"; else { el.style.left = x + "px"; x += 34; }
    el.innerHTML = (roots.has(m) ? '<span class="dot"></span>' : "") + '<span class="key"></span>' +
      (m % 12 === 0 ? `<span class="lbl">${noteName(m)}</span>` : "");
    el.dataset.m = m;
    piano.appendChild(el); keyEls.set(m, el);
  }
  piano.style.width = x + "px";
  labelKeys();
  // scroll so the playable octave is visible
  const c = keyEls.get(12 * (octave + 1));
  if (c) piano.parentElement.scrollLeft = Math.max(0, parseInt(c.style.left) - 120);
}
function labelKeys() {
  keyEls.forEach((el) => { const k = el.querySelector(".key"); if (k) k.textContent = ""; });
  KEYROW.forEach((k, i) => { const el = keyEls.get(12 * (octave + 1) + i); if (el) el.querySelector(".key").textContent = k.toUpperCase(); });
}
let mouseNote = null;
$("piano").addEventListener("pointerdown", (e) => {
  const m = +e.target.closest("[data-m]")?.dataset.m; if (!m) return;
  e.target.setPointerCapture?.(e.pointerId);
  mouseNote = m; play(m);
});
$("piano").addEventListener("pointermove", (e) => {
  if (mouseNote === null) return;
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-m]");
  const m = el ? +el.dataset.m : null;
  if (m && m !== mouseNote) { const prev = mouseNote; mouseNote = m; play(m); stop(prev); } // glissando → legato with high FLOW
});
window.addEventListener("pointerup", () => { if (mouseNote !== null) { stop(mouseNote); mouseNote = null; } });
window.addEventListener("pointercancel", () => { if (mouseNote !== null) { stop(mouseNote); mouseNote = null; } });
$("piano").addEventListener("keydown", (e) => {
  if ($("studioLibrary")?.open || e.target.closest?.('[role="switch"]')) return;
  if (e.key !== " " && e.key !== "Enter") return;
  const key = e.target.closest("[data-m]"); if (!key) return;
  e.preventDefault(); e.stopPropagation(); if (!e.repeat) play(+key.dataset.m);
});
$("piano").addEventListener("keyup", (e) => {
  if (e.key !== " " && e.key !== "Enter") return;
  const key = e.target.closest("[data-m]"); if (!key) return;
  e.preventDefault(); e.stopPropagation(); stop(+key.dataset.m);
});
$("piano").addEventListener("focusout", (e) => {
  const key = e.target.closest("[data-m]"); if (key) stop(+key.dataset.m);
});

function play(m, vel = +$("vel").value) {
  if (!currentInst || current.kind !== "melodic") return;
  audio(); ctx.resume();
  keyEls.get(m)?.classList.add("on");
  currentInst.noteOn(m, vel, ctx.currentTime, flowValue());
  recordEvent({ type: "on", m, vel });
}
function stop(m) {
  if (!currentInst || current.kind !== "melodic" || !ctx) return;
  keyEls.get(m)?.classList.remove("on");
  currentInst.noteOff(m, ctx.currentTime, flowValue());
  recordEvent({ type: "off", m });
}
function changeOctave(delta) {
  octave = Math.max(1, Math.min(7, octave + delta));
  $("octVal").textContent = octave; labelKeys();
  const key = keyEls.get(12 * (octave + 1));
  if (key) $("piano").parentElement.scrollLeft = Math.max(0, parseInt(key.style.left) - 120);
}
$("octDown").onclick = () => changeOctave(-1);
$("octUp").onclick = () => changeOctave(1);

// ---------------------------------------------------------------- pads
const PADKEYS = "1234qwerasdfzxcv".split("");
const TABLA = {
  "Dayan (right hand)": /\b(na|ta|tin|tun|te|tit|ti|ra|re|tu|tete|tirakita|thun)\b/i,
  "Bayan (left hand)": /\b(ge|ghe|ga|gha|ka|ke|kat|ki|bayan|baya|bass)\b/i,
  "Both hands": /\b(dha|dhin|dhi|dhe|dhaa|dhun|dhage)\b/i,
};
let padEls = [];
function buildPads(def) {
  const root = $("pads"); root.innerHTML = ""; padEls = [];
  const groups = new Map();
  const isTabla = /tabla/i.test(def.name + def.path);
  def.pads.forEach((p, i) => {
    let g = "Pads";
    if (isTabla) g = Object.keys(TABLA).find((k) => TABLA[k].test(p.label.replace(/[^a-z ]/gi, " "))) || "Other strokes & phrases";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });
  if (isTabla) {
    const note = document.createElement("p"); note.className = "hint";
    note.textContent = "Tabla pads are grouped by the bol in each file name (dayan/bayan guessed from the name, not analysed audio).";
    root.appendChild(note);
  }
  groups.forEach((idxs, g) => {
    const box = document.createElement("div"); box.className = "group";
    if (groups.size > 1) { const h = document.createElement("h4"); h.textContent = g; box.appendChild(h); }
    const grid = document.createElement("div"); grid.className = "padgrid";
    idxs.forEach((i) => {
      const p = def.pads[i];
      const b = document.createElement("button"); b.className = "pad";
      b.innerHTML = `<span class="pl"></span><span><span class="pk"></span> <span class="pv"></span></span>`;
      b.querySelector(".pl").textContent = p.label;
      b.querySelector(".pv").textContent = p.files.length > 1 ? `${p.files.length} variations` : "";
      b.onpointerdown = () => hitPad(i);
      b.onpointerup = b.onpointerleave = () => releasePad(i);
      b.onclick = (e) => { if (e.detail === 0) hitPad(i); };
      grid.appendChild(b); padEls[i] = b;
    });
    box.appendChild(grid); root.appendChild(box);
  });
  // key hints follow on-screen order
  const order = [...root.querySelectorAll(".pad")];
  order.forEach((el, n) => { if (PADKEYS[n]) el.querySelector(".pk").textContent = PADKEYS[n].toUpperCase(); });
  padOrder = order.map((el) => padEls.indexOf(el));
}
let padOrder = [];
function hitPad(i, vel = +$("vel").value) {
  if (!currentInst || current.kind === "melodic") return;
  audio(); ctx.resume();
  currentInst.hit(i, vel, ctx.currentTime, $("choke").checked);
  const el = padEls[i]; if (el) { el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 120); }
  recordEvent({ type: "hit", i, vel });
}

function releasePad(i) {
  if (!currentInst || current.kind === "melodic" || !ctx) return;
  const now = ctx.currentTime;
  currentInst.releasePad(i, now);
  if (!currentInst.isPhrase(i)) return;
  const live = [...liveLog].reverse().find(event => event.type === "hit" && event.i === i && event.d === undefined);
  if (live) live.d = Math.max(.02, now - live.at);
  beatUI?.render();
}
// ---------------------------------------------------------------- keyboard + MIDI
const downKeys = new Map();
// Space is play/stop everywhere (also on a focused button, step or clip), except while typing in a text field
// (BUGS.md D1). Buttons still activate with Enter.
const TYPING = "input:not([type=checkbox]):not([type=range]):not([type=radio]):not([type=button]), select, textarea, [contenteditable=true]";
window.addEventListener("keydown", (e) => {
  if ($("studioLibrary")?.open || e.target.closest?.('[role="switch"]')) return;
  if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || exporting || e.target.closest?.(TYPING)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (!e.repeat) $("playBtn").click();
}, true);
window.addEventListener("keyup", (e) => { if (e.key === " " && !e.target.closest?.('[role="switch"]') && !e.target.closest?.(TYPING)) e.preventDefault(); }, true); // no button click on release
let keyHintAt = 0;
const keyHint = (text) => { if (performance.now() - keyHintAt > 4000) { keyHintAt = performance.now(); $("status").textContent = text; } };
window.addEventListener("keydown", (e) => {
  if (e.target.closest("input:not([type=range]), select, textarea, [contenteditable=true], .inspector, #pianoRoll, #studioLibrary") || e.ctrlKey || e.metaKey || e.altKey || exporting) return;
  const k = e.key.toLowerCase();
  const isNoteKey = current?.kind === "melodic" ? KEYROW.includes(k) : PADKEYS.includes(k);
  if (e.target.closest(".arrangement")) { // the timeline uses V B C G L K; tell the player why notes don't sound here (D2)
    if (isNoteKey && !"vbcglk".includes(k)) keyHint("The timeline has focus: click the player (keyboard or pads) to play notes with the keys.");
    return;
  }
  if ($("patternEditor").classList.contains("collapsed")) { if (isNoteKey) keyHint("The player is collapsed: open it to play notes with the keys."); return; }
  if (e.repeat || downKeys.has(k)) return;
  if (e.key === "Shift") { currentInst?.setSustain(true, flowValue()); return; }
  if (current?.kind === "melodic") {
    if (k === "z") { $("octDown").click(); return; }
    if (k === "x") { $("octUp").click(); return; }
    const i = KEYROW.indexOf(k);
    if (i >= 0) { const midi = 12 * (octave + 1) + i; downKeys.set(k, midi); play(midi); }
  } else {
    const n = PADKEYS.indexOf(k);
    if (n >= 0 && padOrder[n] !== undefined) { downKeys.set(k, { pad: padOrder[n] }); hitPad(padOrder[n]); }
  }
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (e.key === "Shift") { currentInst?.setSustain(false, flowValue()); return; }
  if (!downKeys.has(k)) return;
  const midi = downKeys.get(k); downKeys.delete(k);
  if (typeof midi === "number") stop(midi); else if (midi?.pad !== undefined) releasePad(midi.pad);
});
window.addEventListener("blur", () => {
  downKeys.clear(); mouseNote = null;
  currentInst?.allOff(); keyEls.forEach((key) => key.classList.remove("on"));
});
if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then((acc) => {
    const attach = () => {
      let n = 0;
      acc.inputs.forEach((inp) => { n++; inp.onmidimessage = (msg) => {
        const [st, d1, d2] = msg.data, type = st & 0xf0;
        if (!current) return; // no instrument yet (D6)
        // pads: MIDI note 36 (C2) = first pad, wrapping in both directions so low notes work too (D4)
        const pad = current.kind === "melodic" ? null : (((d1 - 36) % current.pads.length) + current.pads.length) % current.pads.length;
        if (type === 0x90 && d2 > 0) pad === null ? play(d1, d2 / 127) : hitPad(pad, d2 / 127);
        else if (type === 0x80 || (type === 0x90 && d2 === 0)) pad === null ? stop(d1) : releasePad(pad); // phrase pads stop on release (D5)
        else if (type === 0xb0 && d1 === 64) currentInst?.setSustain(d2 >= 64, flowValue());
      }; });
      $("midiState").textContent = n ? `MIDI: ${n} input(s) connected` : "";
    };
    attach(); acc.onstatechange = attach;
  }).catch(() => {});
}

// ---------------------------------------------------------------- flow + mix UI
function showFlow() {
  const v = flowValue(), p = flowParams(v);
  $("flowVal").textContent = v;
  document.querySelectorAll('[data-flow]').forEach(button=>button.setAttribute('aria-pressed',String(+button.dataset.flow===v)));
  $("flowDetail").textContent = `attack ${p.attack} ms · release ${p.release} ms · ${p.legato ? `legato, crossfade ${p.xfade} ms` : "separate notes"}${p.glide ? ` · glide ${p.glide} ms` : ""}`;
  $("flowDetail").title = $("flowDetail").textContent;
}
$("flow").oninput = () => {
  showFlow();
  const layer = generatedLayer(activePattern);
  if (layer?.def?.kind === "melodic" && !$("patternEditor").classList.contains("collapsed")) { layer.flow = flowValue(); renderLayers(); }
};
$("flow").onchange = () => {
  if (!generatedLayer(activePattern) || !playing) return;
  const position = playbackPosition(); togglePlay(); togglePlay(false, position);
};
document.querySelectorAll('[data-flow]').forEach(button=>{button.onclick=()=>{$('flow').value=button.dataset.flow;$('flow').dispatchEvent(new Event('input'));$('flow').dispatchEvent(new Event('change'));};});
showFlow();
$("rev").oninput = () => { if (reverbSend) reverbSend.gain.setTargetAtTime(+$("rev").value, ctx.currentTime, 0.05); };

// ---------------------------------------------------------------- patterns + arrangement playback
// Layers store events in seconds; playback uses a look-ahead scheduler.
let project = createProject(), activePattern = project.patterns[0], layers = activePattern.layers;
let stepUI = null, rollUI = null, viewsUI = null, beatUI = null, arrangementUI = null, generatorUI = null, dockUI = null, humUI = null, inspectorUI = null, humming = false, playbackMode = "song", playheadFrame = null, recordingLane = null;
const songEngines = new Map();
const transportSounds = new Set(), transportTimers = new Set();
let playing = false, schedTimer = null, metro = false, initialPlaybackOffset = 0;
let revoiceGeneration = 0, originalGeneration = 0;
const spb = () => 60 / (+$("bpm").value || 90);
const loopBeats = () => activePattern.lengthSec / spb();

function syncProjectUI() {
  activePattern = project.patterns.find(pattern => pattern.id === project.activePatternId);
  layers = activePattern.layers;
  for (const pattern of project.patterns) for (const layer of pattern.layers) {
    if (layer.kind === "audio") continue;
    layer.id ||= newId(); layer.instrumentId ||= layer.def?.id;
    layer.def ||= library.find(instrument => instrument.id === layer.instrumentId);
    if (layer.def && !layer.inst) { layer.inst = new Instrument(layer.def); layer.inst.load(); }
  }
  const bars = +(activePattern.lengthSec / (4 * 60 / project.bpm)).toFixed(6);
  // an odd length gets ONE extra option (replaced, never piled up: BUGS.md F1)
  [...$("bars").options].filter(option => option.getAttribute?.("data-custom") && +option.value !== bars).forEach(option => option.remove());
  if (![...$("bars").options].some(option => +option.value === bars)) {
    const option = document.createElement("option"); option.value = bars; option.setAttribute("data-custom", "1");
    option.textContent = `${+bars.toFixed(2)} bar${bars === 1 ? "" : "s"} (${activePattern.lengthSec.toFixed(2)} s)`; $("bars").appendChild(option);
  }
  $("bars").value = bars; $("bpm").value = project.bpm;
  $("editorTitle").textContent = activePattern.name + " · PLAYER" + (recordingLane === null ? "" : " · LANE " + (recordingLane + 1));
  const tuneLayer = generatedLayer(activePattern);
  if (tuneLayer) { $("flow").value = tuneLayer.flow; showFlow(); }
  renderLayers(); arrangementUI?.render(); generatorUI?.setPattern(activePattern); stepUI?.render();
  if (rollUI?.isOpen() && !rollCommitting) rollUI.refresh();
}
let rollCommitting = false;
// Edits never stop playback: the live scheduler picks them up within ~0.2 s (BUGS.md A2, A4, B1-B3).
function editProject(mutation) {
  if (!playing) { currentInst?.allOff(); clearEffects(); }
  project.bpm = Math.min(220, Math.max(40, +$("bpm").value || 90));
  const before = snapshotProject(project);
  try { mutation(project); } catch (error) { project = before; syncProjectUI(); throw error; } // a failed edit changes nothing
  remember(before);
  if (!playing) songEngines.clear();
  syncProjectUI();
  if (playing) applyEffects();
  scheduleAutosave();
}
// ---------------------------------------------------------------- undo / redo (BUGS.md E1)
// Every edit goes through editProject, so one snapshot per edit gives undo/redo for all of them (clip moves, cuts,
// steps, piano roll, deletes...). Snapshots copy the plain data and share the loaded instruments and audio buffers.
const RUNTIME_KEYS = new Set(["def", "inst", "buffer"]);
function snapshotProject(value) {
  if (Array.isArray(value)) return value.map(snapshotProject);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value)) out[key] = RUNTIME_KEYS.has(key) ? value[key] : snapshotProject(value[key]);
  return out;
}
const undoStack = [], redoStack = [], HISTORY = 100;
function remember(before) { undoStack.push(before); if (undoStack.length > HISTORY) undoStack.shift(); redoStack.length = 0; }
function restore(from, to, label) {
  if (!from.length) { $("status").textContent = `Nothing to ${label.toLowerCase()}`; return false; }
  to.push(snapshotProject(project)); project = from.pop();
  if (!project.patterns.some(pattern => pattern.id === project.activePatternId)) project.activePatternId = project.patterns[0].id;
  if (!playing) { songEngines.clear(); clearEffects(); }
  syncProjectUI(); if (playing) applyEffects();
  scheduleAutosave();
  $("status").textContent = `${label} (${undoStack.length} undo · ${redoStack.length} redo left) — Ctrl+Z / Ctrl+Shift+Z`;
  return true;
}
const undo = () => restore(undoStack, redoStack, "Undo"), redo = () => restore(redoStack, undoStack, "Redo");
function clearHistory() { undoStack.length = 0; redoStack.length = 0; }
window.addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (event.target.closest?.("input:not([type=checkbox]):not([type=range]), textarea, select, [contenteditable=true]")) return; // text fields keep their own undo
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
  else if ((key === "z" && event.shiftKey) || key === "y") { event.preventDefault(); redo(); }
});
// ---------------------------------------------------------------- autosave (BUGS.md G1)
// The project is kept in this browser after every edit (and on leaving), and restored on the next visit.
const AUTOSAVE_KEY = "musearena.autosave";
let autosaveTimer = null;
function autosaveNow() {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  let state = "saved";
  try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(projectData({ ...project, bpm: Math.min(220, Math.max(40, +$("bpm").value || 90)) }))); } catch { state = "failed"; }
  notifyAutosave(state);
}
function scheduleAutosave() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(autosaveNow, 800); notifyAutosave("pending"); }
// the header cloud icon listens for this (chrome.js); silent where there is no DOM event support (unit checks)
function notifyAutosave(state) { if (typeof CustomEvent === "function") document.dispatchEvent(new CustomEvent("musearena:autosave", { detail: { state } })); }
window.addEventListener("pagehide", () => { if (autosaveTimer) autosaveNow(); });
function setPatternLength(seconds) { editProject(() => {
  activePattern.lengthSec = Math.min(3600, Math.max(.001, seconds || .001));
  const end = activePattern.lengthSec;
  for (const layer of layers) layer.events = layer.events.filter(event => event.type === "off" || event.t < end)
    .map(event => ({ ...event, t: Math.min(event.t, end) }));
}); }
$("bars").onchange = () => {
  if ($("bars").value === "fit") { const fit = fitLength(layers); if (fit) setPatternLength(fit); else { syncProjectUI(); $("status").textContent = "Nothing to fit yet: this beat has no notes."; } return; }
  setPatternLength(+$("bars").value * 4 * spb());
};
$("patternLength").onchange = () => setPatternLength(+$("patternLength").value);
$("bpm").onchange = () => { project.bpm = Math.min(220, Math.max(40, +$("bpm").value || 90)); syncProjectUI(); applyEffects(); };
function setPlaybackMode(mode) {
  if (playing) togglePlay();
  playbackMode = mode;
  $("modePattern").classList.toggle("on", mode === "pattern"); $("modePattern").setAttribute("aria-pressed", String(mode === "pattern"));
  $("modeSong").classList.toggle("on", mode === "song"); $("modeSong").setAttribute("aria-pressed", String(mode === "song"));
  beatUI?.render();
  arrangementUI?.setPlayhead(null);
  // a pattern always loops, so LOOP (the song loop) is greyed out in PATTERN mode (BUGS.md A7)
  $("songLoop").disabled = mode === "pattern";
  const loopLabel = $("songLoop").closest?.("label");
  if (loopLabel) loopLabel.title = mode === "pattern" ? "PATTERN mode always loops the beat. LOOP is for SONG mode." : "Loop the highlighted part of the song (L)";
}
$("modePattern").onclick = () => setPlaybackMode("pattern");
$("modeSong").onclick = () => setPlaybackMode("song");
// Opening a beat never changes PATTERN/SONG or stops playback (BUGS.md A3/A6): only the mode buttons and PLAY BEAT do.
function openPatternEditor(usePatternInstrument = false) {
  const instrument = activePattern.layers[0]?.def;
  if (usePatternInstrument && instrument && current !== instrument) select(instrument, false);
  dockUI?.expand(true); requestAnimationFrame(() => changeOctave(0));
}
$("editPattern").onclick = () => {
  viewsUI.set("beat"); openPatternEditor(true); $("patternDetails").open = true;
  $("patternDetails").scrollIntoView({block:"center"}); $("patternName").focus({preventScroll:true});
};
function selectRecordingTarget(id, lane = null) {
  recordingLane = lane;
  if (project.activePatternId !== id) editProject(project => { project.activePatternId = id; });
  else syncProjectUI();
  openPatternEditor(true);
}
window.addEventListener("keydown", event => {
  if (event.key === "Escape") { currentInst?.allOff(); downKeys.clear(); }
});
function saveProject() {
  if (playing) togglePlay();
  project.bpm = Math.min(220, Math.max(40, +$("bpm").value || 90));
  const data = projectData(project);
  let savedLocally = true;
  try { rememberProject(data); } catch { savedLocally = false; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = (project.name.replace(/[^\w -]+/g,"").trim() || "project") + ".muse.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("status").textContent = savedLocally ? "Project saved in Projects and downloaded" : "Project downloaded. Browser storage is full or unavailable.";
}
let previewEngine = null;
function rollFocus() { requestAnimationFrame(() => { $("pianoRoll").focus({ preventScroll: true }); $("pianoRoll").scrollIntoView({ block: "nearest" }); }); }
// ---------------------------------------------------------------- beat maker actions
function beatState() {
  return { bpm: +$("bpm").value || 90, armed: liveArmed, previewing: !!livePreview, humming, humBlocked: !humming && !!$("humBtn").disabled,
    playingPattern: playing && playbackMode === "pattern", canCapture: liveLog.some(event => event.type !== "off" && event.instrumentId === current?.id), live: liveTake(),
    onTimeline: project.arrangement.clips.filter(clip => clip.ref === activePattern.id).length };
}
// SAVE WHAT I PLAYED: the last phrase (no gap longer than 4 s) on the current instrument becomes a new beat.
// Times are kept exactly as played, relative to the first note; only the beat length is rounded up to whole bars.
function liveTake() {
  const first = liveLog.findIndex(event => event.type !== "off");
  if (first < 0) return null;
  const log = liveLog.slice(first), t0 = log[0].at, groups = new Map();
  // Played along with PLAY BEAT: the take keeps its place in the beat (first note where it landed in the loop).
  const synced = log[0].loopPos !== undefined && log[0].patternId === activePattern.id, shift = synced ? log[0].loopPos : 0;
  for (const event of log) {
    if (!groups.has(event.instrumentId)) groups.set(event.instrumentId, { instrumentId: event.instrumentId, flow: event.flow, choke: !!event.choke, held: new Map(), events: [] });
    const group = groups.get(event.instrumentId), t = Math.max(0, event.at - t0) + shift;
    if (event.type === "hit") group.events.push({ type: "hit", t, i: event.i, vel: event.vel, ...(event.d ? { d: event.d } : {}) });
    else if (event.type === "on") { if (group.held.has(event.m)) group.events.push({ type: "off", t, m: event.m }); group.held.set(event.m, t); group.events.push({ type: "on", t, m: event.m, vel: event.vel }); }
    else if (group.held.has(event.m)) { group.held.delete(event.m); group.events.push({ type: "off", t, m: event.m }); }
  }
  const all = [...groups.values()].flatMap(group => group.events), last = Math.max(...all.map(event => event.t)), bar = 4 * spb();
  const nowT = ctx ? Math.max(last, ctx.currentTime - t0) : last;
  for (const group of groups.values()) group.held.forEach((_, m) => group.events.push({ type: "off", t: nowT + .05, m }));
  const end = Math.max(...[...groups.values()].flatMap(group => group.events).map(event => event.t)) + .05;
  // fit the loop to what was played (no rounding up to whole bars, which left a silent gap before each repeat)
  const beatLen = activePattern.lengthSec;
  const lengthSec = Math.min(3600, synced ? beatLen * Math.max(1, Math.ceil((end - .05 - 1e-6) / beatLen)) : fitLength([...groups.values()]) || bar);
  const count = all.filter(event => event.type !== "off").length;
  return { name: "Live take", lengthSec, count, span: end, synced,
    layers: [...groups.values()].map(({ held, ...layer }) => ({ ...layer, muted: false, events: layer.events.sort((x, y) => x.t - y.t) })) };
}
// ▶ on the live take: hear it once on its own instruments, with a playhead that follows it.
let livePreview = null;
function stopLivePreview() {
  if (!livePreview) return;
  livePreview.engines.forEach(engine => engine.allOff()); cancelAnimationFrame(livePreview.frame);
  livePreview = null; beatUI?.setPlayhead(null); beatUI?.render();
}
function playLiveTake() {
  if (livePreview) { stopLivePreview(); return; }
  const take = liveTake(); if (!take) return;
  if (playing) togglePlay();
  audio(); ctx.resume();
  const start = ctx.currentTime + .08, engines = [];
  for (const layer of take.layers) {
    const def = library.find(item => item.id === layer.instrumentId); if (!def) continue;
    const engine = new Instrument(def, () => laneOutput(0)); engines.push(engine);
    for (const event of layer.events) {
      if (event.type === "on") engine.noteOn(event.m, event.vel, start + event.t, layer.flow);
      else if (event.type === "off") engine.noteOff(event.m, start + event.t, layer.flow);
      else engine.hit(event.i, event.vel, start + event.t, layer.choke, event.d);
    }
  }
  livePreview = { engines, frame: 0 };
  const tick = () => {
    if (!livePreview) return;
    const elapsed = ctx.currentTime - start;
    if (elapsed > take.span + .5) { stopLivePreview(); return; }
    beatUI?.setPlayhead(Math.max(0, elapsed) / take.lengthSec); livePreview.frame = requestAnimationFrame(tick);
  };
  beatUI?.render(); tick();
}
// ADD TO BEAT: the live take becomes new layer(s) of the current beat (layering without REC).
function keepIntoBeat() {
  stopLivePreview();
  const take = liveTake();
  if (!take) { $("status").textContent = "Play some keys or pads first: whatever you play shows up in LIVE TAKE."; return; }
  if (activePattern.layers.length + take.layers.length > 64) { $("status").textContent = "This beat already has the maximum number of layers"; return; }
  editProject(() => {
    // a synced take that ran over several passes is folded into the one loop (overdub), keeping each note's place
    const fold = take.synced && take.lengthSec > activePattern.lengthSec;
    activePattern.layers.push(...take.layers.map(layer => ({ id: newId(), ...layer, events: fold ? foldEvents(layer.events, activePattern.lengthSec) : layer.events })));
    if (!take.synced) activePattern.lengthSec = Math.max(activePattern.lengthSec, take.lengthSec);
  });
  liveLog.length = 0; beatUI?.render();
  $("status").textContent = `Added ${take.count} note${take.count === 1 ? "" : "s"} to ${activePattern.name} as a new layer. PLAY BEAT to hear it, ADD TO TIMELINE to arrange it.`;
}
// Wrap events played over several passes of a loop into one loop length; a note never runs past the loop end.
function foldEvents(events, len) {
  const out = [], open = new Map();
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    if (event.type === "hit") out.push({ ...event, t: event.t % len });
    else if (event.type === "on") open.set(event.m, event);
    else if (open.has(event.m)) {
      const on = open.get(event.m), start = on.t % len; open.delete(event.m);
      out.push({ ...on, t: start }, { type: "off", m: event.m, t: Math.min(len, start + (event.t - on.t)) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
// Drag to timeline: the live take becomes its own pattern ("Take NN") placed where it is dropped.
function captureTake(place = null) {
  stopLivePreview();
  const take = liveTake();
  if (!take) { $("status").textContent = "Play some keys or pads first: whatever you play shows up in LIVE TAKE."; return null; }
  if (project.patterns.length >= 128) { $("status").textContent = "Pattern limit reached"; return null; }
  const takes = project.patterns.filter(pattern => /^Take \d+$/.test(pattern.name)).length;
  const pattern = { id: newId(), name: "Take " + String(takes + 1).padStart(2, "0"), lengthSec: take.lengthSec,
    layers: take.layers.map(layer => ({ id: newId(), ...layer })) };
  setPlaybackMode(place ? playbackMode : "pattern");
  editProject(project => {
    project.patterns.push(pattern); project.activePatternId = pattern.id;
    if (place) {
      const a = project.arrangement, lane = Math.min(place.lane, a.lanes.length - 1), start = Math.max(0, Math.min(place.start, 3600 - pattern.lengthSec));
      a.lengthSec = Math.min(3600, Math.max(a.lengthSec, Math.ceil(start + pattern.lengthSec)));
      a.clips.push({ id: newId(), kind: "pattern", ref: pattern.id, lane, start, length: pattern.lengthSec, loopLength: pattern.lengthSec, trimStart: 0, fadeIn: 0, fadeOut: 0, offsetMs: 0 });
    }
  });
  liveLog.length = 0; beatUI?.render();
  $("status").textContent = place ? `${pattern.name} (${take.count} notes) placed on ${project.arrangement.lanes[Math.min(place.lane, project.arrangement.lanes.length - 1)].name} at ${place.start.toFixed(3)} s`
    : `Kept ${take.count} note${take.count === 1 ? "" : "s"} as ${pattern.name}. Drag it from the pattern bar onto a lane, or ADD TO TIMELINE.`;
  return pattern;
}
function addBeatToTimeline(pattern = activePattern) {
  const a = project.arrangement;
  if (a.clips.length >= 1024) { $("status").textContent = "Clip limit reached"; return; }
  if (!pattern.layers.length) { $("status").textContent = "This beat is empty. Record or save some notes first."; return; }
  const selection = arrangementUI?.getSelection(), lane = Math.min(a.lanes.length - 1, Math.max(0, selection?.lane ?? recordingLane ?? 0));
  const start = Math.max(0, ...a.clips.filter(clip => clip.lane === lane).map(clip => clip.start + clip.offsetMs / 1000 + clip.length));
  if (start + pattern.lengthSec > 3600) { $("status").textContent = "No room left on this lane"; return; }
  editProject(() => {
    a.lengthSec = Math.max(a.lengthSec, Math.ceil(start + pattern.lengthSec));
    a.clips.push({ id: newId(), kind: "pattern", ref: pattern.id, lane, start, length: pattern.lengthSec,
      loopLength: pattern.lengthSec, trimStart: 0, fadeIn: 0, fadeOut: 0, offsetMs: 0 });
  });
  $("status").textContent = `${pattern.name} added to ${a.lanes[lane].name} at ${start.toFixed(3)} s. Press SONG + PLAY to hear the timeline.`;
}
const AUDIO_TYPES = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", aif: "audio/aiff", aiff: "audio/aiff", webm: "audio/webm" };
// Audio drop: the server re-encodes the file to WAV in output/imports/; it lands as an audio clip on the lane.
async function importAudio(file, lane = 0, start = 0) {
  const targetProject = project;
  const ext = (file.name.split(".").pop() || "").toLowerCase(), type = file.type && /^(audio|video\/webm)/.test(file.type) ? file.type : AUDIO_TYPES[ext];
  if (!type) { $("status").textContent = `${file.name} isn't an audio file`; return null; }
  $("status").textContent = `Importing ${file.name}…`;
  try {
    if (file.size > 20_000_000) throw Error("Audio files must be under 20 MB.");
    const buffer = await audio().decodeAudioData(await file.arrayBuffer());
    if (buffer.duration > 3600) throw Error("Choose a recording under one hour.");
    const body = {url: "/output/imports/" + crypto.randomUUID() + ".wav", name:file.name};
    const store = await caches.open("musearena-imports-v1");
    await store.put(body.url, new Response(file, {headers:{"Content-Type":type}}));
    if (project !== targetProject) throw Error("Project changed during import");
    const duration = Math.min(3600, buffer.duration), a = project.arrangement;
    const pattern = { id: newId(), name: body.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 160) || "Audio", lengthSec: duration,
      layers: [{ id: newId(), kind: "audio", audio: { url: body.url, duration, model: "import" }, buffer, muted: false, flow: 0, choke: false, events: [] }] };
    const at = Math.max(0, Math.min(start, 3600 - duration));
    editProject(() => {
      project.patterns.push(pattern);
      a.lengthSec = Math.min(3600, Math.max(a.lengthSec, Math.ceil(at + duration)));
      a.clips.push({ id: newId(), kind: "pattern", ref: pattern.id, lane: Math.min(lane, a.lanes.length - 1), start: at, length: Math.min(duration, a.lengthSec - at),
        loopLength: duration, trimStart: 0, fadeIn: 0, fadeOut: 0, offsetMs: 0 });
    });
    $("status").textContent = `${pattern.name} (${duration.toFixed(2)} s) added to ${a.lanes[Math.min(lane, a.lanes.length - 1)].name} at ${at.toFixed(3)} s`;
    return pattern;
  } catch (error) { $("status").textContent = "Audio import failed: " + error.message; return null; }
}
async function importFiles(files, lane = 0, start = 0) {
  let at = start;
  for (const file of files) { const pattern = await importAudio(file, lane, at); if (pattern) at += pattern.lengthSec; }
}
window.museImport = importAudio;

// Audio clip editing (Timeline): reverse / time-stretch keeping pitch. Non-destructive: the server writes a new WAV,
// a new pattern holds it, and only the selected clip switches to it; the original stays in the pattern bar.
async function editAudioClip(op) {
  const clip = arrangementUI?.getSelection().clip, pattern = clip && project.patterns.find(item => item.id === clip.ref);
  const layer = pattern?.layers.find(item => item.kind === "audio");
  if (!layer) { $("status").textContent = "Select an audio clip first"; return; }
  const factor = Math.min(4, Math.max(.25, +$("clipStretch").value || 1));
  if (op === "stretch" && Math.abs(factor - 1) < 1e-3) { $("status").textContent = "Set STRETCH × to something other than 1"; return; }
  $("status").textContent = op === "reverse" ? "Reversing…" : `Stretching ×${factor}…`;
  try {
    if (op !== "reverse") throw Error("Time stretching requires the desktop edition.");
    const original = layer.buffer;
    const buffer = audio().createBuffer(original.numberOfChannels, original.length, original.sampleRate);
    for (let ch=0; ch<buffer.numberOfChannels; ch++) {
      buffer.copyToChannel(original.getChannelData(ch),ch);
      buffer.getChannelData(ch).reverse();
    }
    const body = {url:"/output/imports/" + crypto.randomUUID() + ".wav"};
    const store = await caches.open("musearena-imports-v1");
    await store.put(body.url,new Response(encodeWav(buffer),{headers:{"Content-Type":"audio/wav"}}));
    const duration = Math.min(3600, buffer.duration);
    const edited = { id: newId(), name: `${pattern.name} · ${op === "reverse" ? "reversed" : "×" + +factor.toFixed(2)}`.slice(0, 160), lengthSec: duration,
      layers: [{ id: newId(), kind: "audio", audio: { url: body.url, duration, model: "import" }, buffer, muted: false, flow: 0, choke: false, events: [] }] };
    editProject(() => {
      const a = project.arrangement, target = a.clips.find(item => item.id === clip.id); if (!target) return;
      project.patterns.push(edited); target.ref = edited.id;
      if (op === "stretch") { target.trimStart *= factor; target.length = Math.min(a.lengthSec - target.start, target.length * factor); target.fadeIn *= factor; target.fadeOut *= factor; }
      else if (target.trimStart + target.length <= layer.audio.duration) target.trimStart = Math.max(0, duration - target.trimStart - target.length);
      target.loopLength = duration;
      a.lengthSec = Math.min(3600, Math.max(a.lengthSec, Math.ceil(target.start + target.length)));
      target.fadeOut = Math.min(target.fadeOut, target.length - target.fadeIn);
    });
    $("status").textContent = `${edited.name} ready (${duration.toFixed(2)} s). The original is still in the pattern bar.`;
  } catch (error) { $("status").textContent = "Audio edit failed: " + error.message; }
}

// ---------------------------------------------------------------- export (.mid / .wav)
// PATTERN mode exports the active pattern once; SONG mode exports the whole arrangement (not just the loop),
// honouring lane mute/solo, clip offsets, trims and repeats. Times stay exactly as played (no quantising).
function exportPlan() {
  if (playbackMode !== "song" || !project.arrangement.clips.length) {
    const p = activePattern;
    return { name: p.name, end: p.lengthSec, items: [{ pattern: p, lane: null, clip: { start: 0, length: p.lengthSec, loopLength: p.lengthSec, trimStart: 0, offsetMs: 0, fadeIn: 0, fadeOut: 0 } }] };
  }
  const a = project.arrangement, solo = a.lanes.some(lane => lane.solo);
  const items = a.clips.filter(clip => { const lane = a.lanes[clip.lane]; return !lane.mute && (!solo || lane.solo); })
    .map(clip => ({ pattern: project.patterns.find(p => p.id === clip.ref), lane: a.lanes[clip.lane], clip }));
  const end = Math.max(0, ...a.clips.map(clip => clip.start + clip.offsetMs / 1000 + clip.length));
  return { name: project.name, end, items };
}
function downloadBytes(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileStem = (name) => (name || "musearena").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "musearena";
function exportMidi() {
  if (playing) togglePlay();
  const plan = exportPlan(), tracks = new Map();
  for (const { pattern, lane, clip } of plan.items) {
    for (const event of clipEvents(pattern, clip, +$("bpm").value, 0, Infinity, lane)) {
      if (event.type === "audio") continue;
      const layer = pattern.layers[event.layerIndex], key = (lane?.id || "p") + ":" + layer.id;
      if (!tracks.has(key)) tracks.set(key, { name: [lane?.name, layer.def?.name || layer.instrumentId].filter(Boolean).join(" · "), events: [] });
      tracks.get(key).events.push({ ...event, layerIndex: 0 });
    }
  }
  const list = [...tracks.values()].map(track => ({ name: track.name, notes: notesFromEvents(track.events) })).filter(track => track.notes.length);
  if (!list.length) { $("status").textContent = "Nothing to export yet: record or generate some notes first"; return null; }
  const bytes = encodeMidi(list, +$("bpm").value || 90, plan.name);
  downloadBytes(bytes, fileStem(plan.name) + ".mid", "audio/midi");
  $("status").textContent = `Exported ${list.length} track${list.length > 1 ? "s" : ""} as MIDI (${playbackMode === "song" ? "whole song" : "pattern"})`;
  return bytes;
}
let exporting = false;
async function renderMix() {
  if (playing) togglePlay();
  audio();
  const plan = exportPlan(), tail = 3, sampleRate = ctx.sampleRate;
  if (!(plan.end > 0)) throw new Error("Nothing to render");
  // Load every sample first, on the live context, so the engine swap below lasts only for scheduling.
  const engines = [];
  for (const item of plan.items) for (const layer of item.pattern.layers) {
    if (layer.kind !== "audio" && layer.def) await new Instrument(layer.def).load();
  }
  const live = { ctx, master, reverbSend, buses: new Map(effectBuses) };
  const off = new OfflineAudioContext(2, Math.ceil((plan.end + tail) * sampleRate), sampleRate);
  exporting = true;
  try {
    ctx = off; effectBuses.clear();
    const comp = off.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 3;
    master = off.createGain(); master.gain.value = 0.8;
    const conv = off.createConvolver(); conv.buffer = impulse(2.4);
    reverbSend = off.createGain(); reverbSend.gain.value = +$("rev").value;
    master.connect(comp); master.connect(reverbSend).connect(conv).connect(comp); comp.connect(off.destination);
    for (const { pattern, lane, clip } of plan.items) {
      const faded = lane ? fadeInput(off, clip, t => t, clipOutput(clip)) : laneOutput(0);
      const output = () => faded;
      const perLayer = new Map();
      for (const event of clipEvents(pattern, clip, +$("bpm").value, 0, Infinity, lane)) {
        const layer = pattern.layers[event.layerIndex];
        if (event.type === "audio") {
          if (!layer.buffer) continue;
          const src = off.createBufferSource(); src.buffer = layer.buffer; src.connect(output());
          src.start(event.t, event.sourceOffset, Math.min(event.duration, layer.buffer.duration - event.sourceOffset)); continue;
        }
        if (!perLayer.has(layer.id)) { const inst = new Instrument(layer.def, output); perLayer.set(layer.id, inst); engines.push(inst); }
        const inst = perLayer.get(layer.id);
        if (event.type === "on") inst.noteOn(event.m, event.vel, event.t, layer.flow, event.sourceOffset, event.bend);
        else if (event.type === "off") inst.noteOff(event.m, event.t, layer.flow);
        else inst.hit(event.i, event.vel, event.t, layer.choke, event.d);
      }
    }
    await Promise.all(engines.map(inst => inst.queue));
  } finally {
    ctx = live.ctx; master = live.master; reverbSend = live.reverbSend;
    effectBuses.clear(); live.buses.forEach((bus, key) => effectBuses.set(key, bus));
    exporting = false;
  }
  return { buffer: await off.startRendering(), plan };
}
async function exportWav() {
  $("status").textContent = "Rendering mix…";
  try {
    const { buffer, plan } = await renderMix();
    const bytes = encodeWav(buffer);
    downloadBytes(bytes, fileStem(plan.name) + ".wav", "audio/wav");
    $("status").textContent = `Exported ${buffer.duration.toFixed(1)} s WAV (${playbackMode === "song" ? "whole song" : "pattern"}, with lane FX)`;
    return { seconds: buffer.duration, peak: Math.max(...[0, 1].map(c => buffer.getChannelData(c).reduce((m, v) => Math.max(m, Math.abs(v)), 0))) };
  } catch (error) {
    $("status").textContent = "WAV export failed: " + error.message; throw error;
  }
}
window.museExport = { exportMidi, exportWav, renderMix };

async function loadProject(file) {
  if (file.size > 5 * 1024 * 1024) { $("status").textContent = "Project file exceeds 5 MB — current project kept"; return false; }
  return loadProjectText(await file.text());
}
async function loadProjectText(text, { restored = false } = {}) {
  try {
    const candidate = validateProject(JSON.parse(text), library);
    const definitions = new Map(library.map(instrument => [instrument.id, instrument]));
    const loads = [];
    for (const pattern of candidate.patterns) for (const layer of pattern.layers) {
      if (layer.kind === "audio") {
        loads.push(loadBuffer(layer.audio.url.slice(1)).then(buffer => {
          if (!buffer) return 1;
          layer.buffer = buffer;
          if (Math.abs(buffer.duration - layer.audio.duration) > .1) throw new Error("Generated audio duration changed");
          return 0;
        }));
        continue;
      }
      layer.def = definitions.get(layer.instrumentId); layer.inst = new Instrument(layer.def); loads.push(layer.inst.load());
    }
    if ((await Promise.all(loads)).some(failed => failed > 0)) throw new Error("Some project samples are unavailable");
    if (playing) togglePlay(); stopLivePreview(); liveLog.length = 0; rollUI?.close(); currentInst?.allOff(); clearEffects();
    project = candidate; recordingLane = null; songEngines.clear(); clearHistory(); syncProjectUI();
    const selectedInstrument = generatedLayer(activePattern)?.def || activePattern.layers[0]?.def;
    if (selectedInstrument) await select(selectedInstrument, false);
    $("status").textContent = restored ? `Restored your last session: ${project.name}` : `${project.name} loaded`;
    if (!restored) autosaveNow();
    return true;
  } catch (error) { $("status").textContent = restored ? `Couldn't restore the last session (${error.message}) — started fresh` : `${error.message} — current project kept`; return false; }
}

// Everything played outside REC goes to a short rolling log, so a good phrase can still be kept.
const liveLog = [];
// No REC button: while the live take's ● is on (default), everything you play is kept, at the exact time played.
let liveArmed = true;
let beatMode = "live"; // Beat Maker tab only: "live" or "step"
const inStepMode = () => beatMode === "step" && viewsUI?.get() === "beat";
function setBeatMode(mode, remember = true) {
  beatMode = mode === "step" ? "step" : "live";
  document.body.dataset.beatMode = beatMode;
  $("modeLive").setAttribute("aria-checked", String(beatMode === "live")); $("modeLive").tabIndex = beatMode === "live" ? 0 : -1;
  $("modeStep").setAttribute("aria-checked", String(beatMode === "step")); $("modeStep").tabIndex = beatMode === "step" ? 0 : -1;
  if (remember) try { localStorage.setItem("musearena.beatMode", beatMode); } catch {}
  if (beatMode === "step") { stopLivePreview(); currentInst?.allOff(); downKeys.clear(); stepUI?.render(); }
  else beatUI?.render();
  if (remember && viewsUI?.get() === "beat") $("status").textContent = beatMode === "step"
    ? "STEP GRID: click steps to place hits exactly. Nothing you play is recorded here."
    : "LIVE: play keys or pads; with RECORD on, what you play is kept with its exact timing.";
  window.dispatchEvent(new Event("resize"));
}
function recordEvent(ev) {
  if (!liveArmed || inStepMode() || !ctx || !current) return; // the step grid is for placing hits, not recording
  const entry = { ...ev, at: ctx.currentTime, instrumentId: current.id, flow: flowValue(), choke: $("choke").checked };
  if (playing && playbackMode === "pattern") {
    // where in the looping beat you heard this: the speakers lag the clock by the output latency (BUGS.md C1)
    const len = activePattern.lengthSec, heard = absolutePosition() - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
    entry.loopPos = ((heard % len) + len) % len; entry.patternId = activePattern.id;
  }
  liveLog.push(entry);
  if (liveLog.length > 20000) liveLog.shift();
  beatUI?.render();
  if (ev.type !== "off" && !liveFrame) liveFrame = requestAnimationFrame(followLive);
}
// While a key is held, keep redrawing so the held note visibly grows in the live take.
let liveFrame = 0;
function followLive() { if (downKeys.size || mouseNote !== null) { beatUI?.render(); liveFrame = requestAnimationFrame(followLive); } else { liveFrame = 0; beatUI?.render(); } }
function click(t, accent) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1600 : 1000; g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(g).connect(ctx === liveOutput.context ? liveOutput : ctx.destination); o.start(t); o.stop(t + 0.06);
  transportSounds.add(o); o.onended = () => transportSounds.delete(o);
}
function transportLater(callback, delay) {
  const timer = setTimeout(() => { transportTimers.delete(timer); callback(); }, Math.max(0, delay));
  transportTimers.add(timer);
}
// Where the song ends: after the last clip (BUGS.md A8), never in the empty tail of the 64 s canvas.
function songEnd() {
  const a = project.arrangement;
  return a.clips.length ? Math.min(a.lengthSec, Math.max(...a.clips.map(clip => clip.start + clip.offsetMs / 1000 + clip.length))) : a.lengthSec;
}
function songRange() {
  const a = project.arrangement;
  return a.loop.on ? { start: a.loop.start, end: a.loop.end } : { start: 0, end: songEnd() };
}
function scheduleStem(layer, event, time,output=master) {
  if (!layer.buffer) return;
  const when = Math.max(time, ctx.currentTime), late = when - time;
  const offset = event.sourceOffset + late;
  const duration = Math.min(event.duration - late, layer.buffer.duration - offset);
  if (duration <= 0) return;
  const source = ctx.createBufferSource(); source.buffer = layer.buffer;
  source.connect(output); source.start(when, offset, duration);
  transportSounds.add(source); source.onended = () => transportSounds.delete(source);
}
async function addGeneratedPattern(result, fields) {
  const destination = project;
  const url = result.audioUrl || result.url;
  const valid = fields.role === "hum" ? /^\/output\/hums\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.wav$/ : /^\/output\/generated\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(mp3|wav)$/;
  if (!valid.test(url)) throw new Error("Server returned an invalid audio URL");
  const buffer = await loadBuffer(url.slice(1));
  if (!buffer || !(buffer.duration > 0 && buffer.duration <= 3600)) throw new Error("Generated audio could not be decoded");
  const instrument = library.find(instrument => instrument.id === fields.instrumentId);
  const pattern = patternFromTranscription(result, fields, instrument, buffer.duration, flowValue());
  const layer = pattern.layers[0]; layer.def = instrument; layer.inst = new Instrument(instrument);
  if (await layer.inst.load()) throw new Error("Chosen instrument samples are unavailable; preview the stem and retry transcription");
  if (fields.isCurrent && !fields.isCurrent()) return null;
  if (project !== destination) throw new Error("The project changed while loading. Retry transcription to add to the current project.");
  if (project.patterns.length >= 128 || project.arrangement.clips.length >= 1024) throw new Error("Project is full; the generated file is saved on disk");
  setPlaybackMode("pattern");
  if (fields.version) {
    pattern.name = `${fields.role} · ${fields.genre} · V${fields.version}`.slice(0, 160);
    editProject(() => { project.patterns.push(pattern); if (fields.version === 1) project.activePatternId = pattern.id; });
    if (fields.version === 1) { await select(instrument, false); if (!playing) togglePlay(); }
    return { duration: pattern.lengthSec, count: layer.events.filter(event => event.type !== "off").length, instrument: instrument.name, patternId: pattern.id };
  }
  editProject(() => {
    const a = project.arrangement;
    const targetLane = fields.targetLane === undefined ? recordingLane : fields.targetLane;
    let lane = Number.isInteger(targetLane) && a.lanes[targetLane] ? targetLane : a.lanes.findIndex((_, index) => !a.clips.some(clip => clip.lane === index));
    if (lane < 0 && a.lanes.length < 16) {
      lane = a.lanes.length; a.lanes.push({ id: newId(), name: "Lane " + (lane + 1), mute: false, solo: false, loopLength: null });
    }
    if (lane < 0) lane = 0;
    const start = Math.max(0, ...a.clips.filter(clip => clip.lane === lane).map(clip => clip.start + clip.length));
    if (start + pattern.lengthSec > 3600) throw new Error("No room for this pattern in the one-hour song");
    if (fields.role === "hum") pattern.name = "Hummed tune " + String(project.patterns.filter(pattern => pattern.source?.kind === "hum").length + 1).padStart(2,"0");
    project.patterns.push(pattern); project.activePatternId = pattern.id;
    recordingLane = lane;
    a.lengthSec = Math.max(a.lengthSec, start + pattern.lengthSec);
    a.loop.start = Math.min(a.loop.start, start); a.loop.end = Math.max(a.loop.end, start + pattern.lengthSec);
    a.clips.push({ id: newId(), kind: "pattern", ref: pattern.id, lane, start, length: pattern.lengthSec,
      loopLength: pattern.lengthSec, trimStart: 0, offsetMs: 0, fadeIn: 0, fadeOut: 0 });
  });
  await select(instrument, false);
  if (project === destination && project.activePatternId === pattern.id && !playing) togglePlay();
  return { duration: pattern.lengthSec, count: layer.events.filter(event => event.type !== "off").length, instrument: instrument.name, patternId: pattern.id };
}
// ---------------------------------------------------------------- live scheduler
// Playback runs as "passes" (one pattern loop, the song loop, or the rest of the song). Each tick schedules only
// what starts in the next ~0.2 s, so edits made while playing (steps, mutes, loop, clips) are heard almost at once.
let passes = [], schedUntil = 0, includeHeldNext = false, pendingOffs = [], songEndAt = null;
const lookahead = () => document.hidden ? 1.5 : .2; // background tabs tick slowly: schedule further ahead there
// Song: play from `from` to the loop end if the loop lies ahead, else to the song end (BUGS.md A11: the cursor wins).
function songPassFrom(base, from) {
  const a = project.arrangement, toLoop = a.loop.on && from < a.loop.end - 1e-6;
  return { base, from, to: toLoop ? a.loop.end : Math.max(from + .001, songEnd()) };
}
function nextPass(prev) {
  const base = prev.base + (prev.to - prev.from);
  if (playbackMode === "pattern") return { base, from: 0, to: Math.max(.001, activePattern.lengthSec) };
  const a = project.arrangement;
  if (a.loop.on && Math.abs(prev.to - a.loop.end) < 1e-6) return { base, from: a.loop.start, to: a.loop.end }; // reached the loop end: go round
  if (prev.to < songEnd() - 1e-6) return songPassFrom(base, prev.to); // loop switched off (or moved) mid-pass: carry on
  return null; // end of the song
}
function currentPass() {
  const now = ctx.currentTime;
  for (let i = passes.length - 1; i >= 0; i--) if (passes[i].base <= now + 1e-6) return passes[i];
  return passes[0];
}
function absolutePosition() { // pattern: seconds into the pattern; song: song seconds
  if (!playing || !passes.length) return 0;
  const pass = currentPass(); return Math.min(pass.to, pass.from + Math.max(0, ctx.currentTime - pass.base));
}
function playbackPosition() { // the offset togglePlay understands (song: from the loop/song start)
  const pos = absolutePosition();
  return playing && playbackMode === "song" ? Math.max(0, pos - songRange().start) : pos;
}
async function auditionGeneratedPattern(offset = 0) {
  if (!generatedLayer(activePattern)) return;
  if (playing) togglePlay();
  setPlaybackMode("pattern"); togglePlay(false, offset % activePattern.lengthSec);
}
async function toggleOriginal(original) {
  if (!original) return auditionGeneratedPattern($("stemPreview").currentTime || 0);
  const generation = ++originalGeneration, pattern = activePattern;
  const offset = playbackMode === "pattern" ? playbackPosition() : 0;
  if (playing) togglePlay();
  const preview = $("stemPreview"); preview.loop = true;
  if (preview.readyState < 1) await new Promise((resolve, reject) => {
    const ready = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error("Original audio is unavailable")); };
    const clean = () => { clearTimeout(timer); preview.removeEventListener("loadedmetadata", ready); preview.removeEventListener("error", failed); };
    const timer = setTimeout(failed, 15000);
    preview.addEventListener("loadedmetadata", ready); preview.addEventListener("error", failed); preview.load();
  });
  if (generation !== originalGeneration || activePattern !== pattern) return;
  preview.currentTime = Math.min(offset, Math.max(0, (activePattern.source?.duration || 1) - .01));
  try { await preview.play(); } catch (error) { if (generation === originalGeneration) throw error; }
}
async function revoiceGeneratedPattern(instrumentId, padMap) {
  const pattern = activePattern, destination = project, layer = generatedLayer(pattern);
  if (!layer) return;
  const generation = ++revoiceGeneration, instrument = library.find(item => item.id === instrumentId);
  const events = revoicedEvents(layer, instrument, padMap), inst = new Instrument(instrument);
  if (await inst.load()) throw new Error("Instrument samples unavailable — your current voice was kept");
  if (generation !== revoiceGeneration || project !== destination || activePattern !== pattern || !pattern.layers.includes(layer)) return { cancelled: true };
  const wasPlaying = playing, original = !$("stemPreview").paused;
  const position = original ? $("stemPreview").currentTime % pattern.lengthSec : playbackPosition();
  if (playing) togglePlay();
  layer.inst?.allOff(); layer.instrumentId = instrument.id; layer.def = instrument; layer.inst = inst; layer.events = events;
  songEngines.clear(); syncProjectUI(); select(instrument, false);
  if (!wasPlaying || original) setPlaybackMode("pattern");
  togglePlay(false, position);
  if (pattern.source?.kind === "hum") {
    $("humStatus").textContent = `Playing your hum on ${instrument.name}.` + (pattern.source.warning ? " " + pattern.source.warning : "");
    $("humStatus").classList.remove("error");
  }
  return { instrument: instrument.name };
}
// What starts in [p0, p1) of this pass -> jobs {at, run}; notes also queue their release in pendingOffs.
function scheduleWindow(pass, p0, p1, jobs) {
  const toCtx = p => pass.base + (p - pass.from), includeHeld = includeHeldNext; includeHeldNext = false;
  const noteJobs = (inst, layer, event) => {
    const at = toCtx(event.t);
    if (event.type === "hit") jobs.push({ at, run: () => inst.hit(event.i, event.vel, at, layer.choke, event.d) });
    else {
      jobs.push({ at, run: () => inst.noteOn(event.m, event.vel, at, layer.flow, event.sourceOffset, event.bend) });
      const offAt = toCtx(event.off); pendingOffs.push({ at: offAt, off: true, run: () => inst.noteOff(event.m, offAt, layer.flow) });
    }
  };
  if (playbackMode === "song") {
    const a = project.arrangement, solo = a.lanes.some(lane => lane.solo);
    for (const clip of a.clips) {
      const lane = a.lanes[clip.lane]; if (!lane || lane.mute || (solo && !lane.solo)) continue;
      const pattern = project.patterns.find(item => item.id === clip.ref); if (!pattern) continue;
      const events = windowEvents(pattern, clip, p0, p1, { lane, rangeEnd: pass.to, includeHeld }); if (!events.length) continue;
      const fadeKey = clip.id + "@" + pass.base; // a fade envelope per clip per pass
      if (!clipFadeNodes.has(fadeKey)) clipFadeNodes.set(fadeKey, fadeInput(ctx, clip, toCtx, clipOutput(clip)));
      const output = () => clipFadeNodes.get(fadeKey) || clipOutput(clip);
      for (const event of events) {
        const layer = pattern.layers[event.layerIndex];
        if (event.type === "audio") { const at = toCtx(event.t); jobs.push({ at, run: () => scheduleStem(layer, event, at, output()) }); continue; }
        if (!layer.def) continue;
        const key = clip.id + ":" + layer.id; let inst = songEngines.get(key);
        if (!inst || inst.def !== layer.def) { inst = new Instrument(layer.def, output); songEngines.set(key, inst); }
        inst.output = output;
        noteJobs(inst, layer, event);
      }
    }
  } else {
    const loop = { start: 0, length: pass.to, loopLength: pass.to, trimStart: 0, offsetMs: 0 };
    for (const event of windowEvents(activePattern, loop, p0, p1, { includeHeld })) {
      const layer = activePattern.layers[event.layerIndex];
      if (event.type === "audio") { const at = toCtx(event.t); jobs.push({ at, run: () => scheduleStem(layer, event, at, playerOutput()) }); continue; }
      if (!layer.inst) continue;
      layer.inst.output = playerOutput;
      noteJobs(layer.inst, layer, event);
    }
  }
  // metronome + beat lamp on the beat grid (song: counted from 0 s, so bars line up with the ruler)
  const beat = spb();
  for (let n = Math.ceil(p0 / beat - 1e-9); n * beat < p1 - 1e-9; n++) {
    const at = toCtx(n * beat), down = n % 4 === 0;
    if (metro) click(at, down);
    transportLater(() => { $("beatLamp").className = "lamp " + (down ? "down" : "hit"); transportLater(() => ($("beatLamp").className = "lamp"), 90); }, (at - ctx.currentTime) * 1000);
  }
}
function updatePlayhead() {
  if (!playing) return;
  rollUI?.setPlayhead(absolutePosition(), playbackMode, activePattern.id);
  if (playbackMode === "song") arrangementUI?.setPlayhead(absolutePosition());
  else {
    const pos = absolutePosition(), fraction = pos / activePattern.lengthSec;
    beatUI?.setPlayhead(fraction); stepUI?.setPlayhead(fraction); $("songClock").textContent = pos.toFixed(3) + " s";
    if (activePattern.source) $("tuneClock").textContent = pos.toFixed(1) + "s";
  }
  playheadFrame = requestAnimationFrame(updatePlayhead);
}
function schedule() {
  if (!playing) return;
  const horizon = ctx.currentTime + lookahead(), jobs = [];
  for (let guard = 0; schedUntil < horizon - 1e-9 && guard < 64; guard++) {
    const pass = passes.at(-1), pos = pass.from + (schedUntil - pass.base);
    // edits apply to the pass that is playing: a longer/shorter pattern or a moved/toggled loop end takes effect now
    if (playbackMode === "pattern") pass.to = pos < activePattern.lengthSec - 1e-6 ? activePattern.lengthSec : Math.max(pass.from, pos); // shortened past the playhead: wrap now
    else {
      const a = project.arrangement;
      if (a.loop.on && pass.from < a.loop.end && pos < a.loop.end - 1e-6) pass.to = a.loop.end; // loop on / moved: wrap at its end
      else if (!a.loop.on && pos < songEnd() - 1e-6) pass.to = songEnd();                       // loop off: run to the last clip
    }
    const passEnd = pass.base + (pass.to - pass.from);
    if (schedUntil >= passEnd - 1e-9) {
      const next = nextPass(pass);
      if (!next) { if (songEndAt === null) { songEndAt = passEnd; transportLater(() => { if (playing) togglePlay(); }, (passEnd - ctx.currentTime) * 1000); } break; }
      passes.push(next);
      if (passes.length > 8) { const old = passes.shift(); for (const key of clipFadeNodes.keys()) if (key.endsWith("@" + old.base)) clipFadeNodes.delete(key); }
      continue;
    }
    const until = Math.min(horizon, passEnd);
    scheduleWindow(pass, pos, pass.from + (until - pass.base), jobs);
    schedUntil = until;
  }
  // releases that fall due join this batch, so an off and a re-strike of the same note keep their order
  const later = [];
  for (const off of pendingOffs) (off.at < horizon ? jobs : later).push(off);
  pendingOffs = later;
  jobs.sort((x, y) => x.at - y.at || (x.off ? -1 : 0) - (y.off ? -1 : 0)).forEach(job => job.run());
}
function togglePlay(preRoll = false, offset = 0) {
  audio(); ctx.resume();
  if (playing) {
    playing = false; clearInterval(schedTimer); setBtn($("playBtn"), "play", "PLAY"); $("playBtn").classList.remove("on");
    $("playBtn").setAttribute("aria-pressed", "false");
    $("bpm").disabled = $("bars").disabled = false;
    transportTimers.forEach(clearTimeout); transportTimers.clear();
    transportSounds.forEach((sound) => { try { sound.stop(); } catch {} }); transportSounds.clear();
    $("beatLamp").className = "lamp";
    rollUI?.setPlayhead(null); cancelAnimationFrame(playheadFrame); playheadFrame = null; arrangementUI?.setPlayhead(null); beatUI?.setPlayhead(null); stepUI?.setPlayhead(null);
    project.patterns.forEach(pattern => pattern.layers.forEach(layer => layer.inst?.allOff()));
    songEngines.forEach(inst => inst.allOff()); songEngines.clear(); clipFadeNodes.clear(); stopLivePreview();
    passes = []; pendingOffs = [];
    clearEffects(); beatUI?.render();
    return;
  }
  $("stemPreview").pause?.();
  originalGeneration++;
  playing = true; pendingOffs = []; songEndAt = null;
  $("bpm").value = Math.min(220, Math.max(40, +$("bpm").value || 90));
  project.bpm = +$("bpm").value;
  $("bpm").disabled = $("bars").disabled = true;
  // song: offset is from the loop/song start and may be negative (a cursor before the loop); pattern: seconds into it
  const startPos = playbackMode === "song" ? Math.max(0, Math.min(songEnd() - .001, songRange().start + (offset || 0)))
    : Math.max(0, Math.min(activePattern.lengthSec - .001, offset || 0));
  initialPlaybackOffset = startPos;
  const startAt = ctx.currentTime + (startPos ? .015 : .1) + (preRoll ? 4 * spb() : 0);
  if (preRoll) for (let b = 0; b < 4; b++) click(startAt - (4 - b) * spb(), b === 0); // one-bar count-in
  passes = [playbackMode === "song" ? songPassFrom(startAt, startPos) : { base: startAt - startPos, from: 0, to: Math.max(.001, activePattern.lengthSec) }];
  schedUntil = startAt; includeHeldNext = startPos > 0;
  schedTimer = setInterval(schedule, 25); schedule();
  setBtn($("playBtn"), "stop", "STOP"); $("playBtn").classList.add("on");
  $("playBtn").setAttribute("aria-pressed", "true");
  updatePlayhead(); beatUI?.render();
}
// Song cue: clicking a marker sets where SONG playback starts (and restarts playback there if running).
let cueTime = null;
// The cursor: SONG plays from here. Moving it never changes the mode (BUGS.md A6). `soft` (a click on empty lane
// space) only moves it for the next PLAY; the ruler and markers also jump a playing song there.
function jumpTo(t, { soft = false } = {}) {
  cueTime = t;
  if (playing && playbackMode === "song" && !soft) { togglePlay(); togglePlay(false, t - songRange().start); return; }
  if (!playing || playbackMode !== "song") arrangementUI?.setPlayhead(null);
  $("status").textContent = playbackMode === "song" ? `Cursor at ${t.toFixed(3)} s — PLAY starts here` : `Cursor at ${t.toFixed(3)} s — press SONG, then PLAY, to play the timeline from here`;
}
$("playBtn").onclick = () => {
  if (!playing && playbackMode === "song" && !project.arrangement.clips.length) { setPlaybackMode("pattern"); $("status").textContent = "Timeline is empty, so playing the beat. Use ADD TO TIMELINE to arrange it."; }
  if (playing || cueTime === null || playbackMode !== "song") return togglePlay();
  togglePlay(false, cueTime - songRange().start);
};
$("rewindBtn").onclick = () => {cueTime=0;arrangementUI?.setCursor(0);const resume=playing;if(playing)togglePlay();$("stemPreview").pause();arrangementUI?.setPlayhead(null);if(resume)togglePlay();};
$("metroBtn").onclick = () => { metro = !metro; $("metroBtn").classList.toggle("on", metro); $("metroBtn").setAttribute("aria-pressed", String(metro)); };
function renderLayers() {
  beatUI?.render();
  const box = $("layers"); box.innerHTML = "";
  if (!layers.length) { box.innerHTML = '<p class="hint mono">NO LAYERS YET</p>'; return; }
  layers.forEach((L, n) => {
    const row = document.createElement("div"); row.className = "layer" + (L.muted ? " muted" : "");
    row.innerHTML = `<span class="no">${String(n + 1).padStart(2, "0")}</span><div class="nm"><span></span><small></small></div><div class="bar"></div>` +
      `<span class="cnt">${L.events.length} EV</span><button class="btn mute" title="${L.muted ? "Unmute" : "Mute"}"><svg><use href="#i-mute"/></svg></button><button class="btn" title="Delete layer"><svg><use href="#i-x"/></svg></button>`;
    const name = L.kind === "audio" ? (L.audio.model === "import" ? "Imported audio" : "Generated stem") : L.def.name;
    row.querySelector(".nm span").textContent = name;
    row.querySelector(".nm small").textContent = L.kind === "audio" ? `${L.audio.model} · ${L.audio.duration.toFixed(2)} s` : (L.def.kind === "melodic" ? `FLOW ${L.flow}` : "PADS");
    if (L.kind === "audio") row.querySelector(".cnt").textContent = "AUDIO";
    const bar = row.querySelector(".bar"), duration = activePattern.lengthSec;
    if (L.kind === "audio") {
      const span = document.createElement("div"); span.className = "ev";
      span.style.width = Math.min(100, L.audio.duration / duration * 100) + "%"; bar.appendChild(span);
    }
    const open = {};
    L.events.forEach((ev) => {
      if (ev.type === "on") { open[ev.m] = ev; return; }
      const start = ev.type === "off" ? open[ev.m]?.t : ev.t;
      if (start === undefined) return;
      const end = ev.type === "off" ? (ev.t >= start ? ev.t : duration) : start + 0.08;
      const d = document.createElement("div"); d.className = "ev";
      d.style.left = (start / duration * 100) + "%"; d.style.width = ((end - start) / duration * 100) + "%";
      bar.appendChild(d);
    });
    const [muteBtn, delBtn] = row.querySelectorAll("button");
    muteBtn.setAttribute("aria-label", `${L.muted ? "Unmute" : "Mute"} ${name}`);
    muteBtn.setAttribute("aria-pressed", String(L.muted));
    delBtn.setAttribute("aria-label", `Delete ${name} layer`);
    muteBtn.onclick = () => {
      if (playbackMode === "song" || L.kind === "audio") editProject(() => { L.muted = !L.muted; });
      else { L.muted = !L.muted; L.inst.allOff(); renderLayers(); }
    };
    delBtn.onclick = () => {
      editProject(() => { L.inst?.allOff(); const index = layers.indexOf(L); if (index >= 0) layers.splice(index, 1); });
    };
    box.appendChild(row);
  });
}
renderLayers();

document.addEventListener("pointerdown", () => { audio(); ctx.resume(); }, { once: true });
boot().catch((error) => { console.warn("library failed", error); $("status").textContent = "Library unavailable — reload to try again"; });

// A file dropped outside a lane must not navigate away from the project.
window.addEventListener("dragover", event => { if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault(); });
window.addEventListener("drop", event => {
  if (!Array.from(event.dataTransfer?.types || []).includes("Files") || event.target.closest?.(".timeline-lane")) return;
  event.preventDefault(); $("status").textContent = "Drop audio files onto a timeline lane (or use + AUDIO).";
});

// Hum messages also reach the top status line (the hum row hides when the player is squeezed).
// Warnings keep the hum row on screen even when the player is squeezed.
new MutationObserver(() => {
  const status = $("humStatus"), text = status.textContent;
  if (text && !/^HUM records/.test(text)) $("status").textContent = text;
  document.querySelector(".hum-panel").classList.toggle("active", humming || status.classList.contains("error") || !$("humCancel").hidden);
}).observe($("humStatus"), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });

// Project data and timing are independent of the DOM and Web Audio. Times are seconds.
import { validateFx } from './effects.js';
export const newId = () => crypto.randomUUID();
export const snapTime = (time, resolution = .1, bypass = false) => bypass || !resolution ? time : Math.round(Math.round(time / resolution) * resolution * 1e9) / 1e9;
export function createPattern(name = "Pattern 01", lengthSec = 8 / 3) {
  return { id: newId(), name, lengthSec, layers: [] };
}
export function createLane(index = 0) {
  return { id: newId(), name: "Lane " + (index + 1), mute: false, solo: false, loopLength: null };
}
export function createProject() {
  const pattern = createPattern();
  return { schemaVersion: 2, name: "Untitled", bpm: 90, activePatternId: pattern.id, patterns: [pattern],
    arrangement: { lengthSec: 64, lanes: Array.from({ length: 4 }, (_, i) => createLane(i)),
      loop: { on: false, start: 0, end: 8 }, clips: [], markers: [] } }; // loop off: SONG plays everything (BUGS.md A1)
}
export function duplicatePattern(pattern) {
  const copy = { ...pattern, ...(pattern.source ? { source: structuredClone(pattern.source) } : {}), id: newId(), name: pattern.name + " copy", layers: pattern.layers.map(layer => ({
    ...(layer.kind === "audio" ? { kind: "audio", audio: { ...layer.audio }, buffer: layer.buffer } : {}),
    id: newId(), instrumentId: layer.instrumentId || layer.def?.id, flow: layer.flow, choke: layer.choke,
    muted: layer.muted, events: layer.events.map(event => ({ ...event })),
  })) };
  if (copy.source?.layerId) copy.source.layerId = copy.layers[pattern.layers.findIndex(layer => layer.id === pattern.source.layerId)]?.id || copy.source.layerId;
  return copy;
}

// Give each "on" event the pitch curve of the transcribed note it came from (same MIDI note,
// start within 2 ms). Curves are cents relative to the note, sampled at `rate` per second from the attack.
export function attachBends(events, notes = []) {
  const curves = notes.filter(note => note.bendCents?.length && note.bendRate > 0);
  if (!curves.length) return events;
  for (const event of events) {
    if (event.type !== "on" || event.bend) continue;
    const note = curves.find(note => note.m === event.m && Math.abs(note.t - event.t) < .002);
    if (note) event.bend = { rate: note.bendRate, cents: note.bendCents.slice() };
  }
  return events;
}

// Automation points for a note's pitch curve: [{ dt seconds after the (possibly resumed) attack, cents }].
// Skips the part already elapsed when playback starts mid-note; thins very dense curves to <= maxRate/s.
export function bendPoints(bend, sourceOffset = 0, maxRate = 200) {
  if (!bend?.cents?.length || !(bend.rate > 0)) return [];
  const step = Math.max(1, Math.ceil(bend.rate / maxRate)), first = Math.max(0, Math.floor(sourceOffset * bend.rate)), points = [];
  for (let i = first; i < bend.cents.length; i += step) points.push({ dt: Math.max(0, i / bend.rate - sourceOffset), cents: bend.cents[i] });
  return points;
}

// Piano-roll model. Melodic layers: on/off pairs <-> notes {t, d, m, vel, bend?}. Pad layers: hits {t, i, vel, d?}.
// Times are free seconds; nothing is moved onto a grid here.
export function eventsToNotes(events) {
  const notes = [], open = new Map();
  for (const event of [...events].sort((a, b) => a.t - b.t || (a.type === "off" ? -1 : 1))) {
    if (event.type === "hit") notes.push({ t: event.t, i: event.i, vel: event.vel ?? .8, ...(event.d ? { d: event.d } : {}), ...(event.band !== undefined ? { band: event.band } : {}) });
    else if (event.type === "on") {
      if (open.has(event.m)) { const prev = open.get(event.m); prev.d = Math.max(.001, event.t - prev.t); }
      const note = { t: event.t, d: .25, m: event.m, vel: event.vel ?? .8, ...(event.bend ? { bend: event.bend } : {}) };
      notes.push(note); open.set(event.m, note);
    } else if (open.has(event.m)) { const note = open.get(event.m); note.d = Math.max(.001, event.t - note.t); open.delete(event.m); }
  }
  return notes;
}
export function notesToEvents(notes) {
  const events = [];
  for (const note of notes) {
    if (note.i !== undefined) events.push({ type: "hit", t: note.t, i: note.i, vel: note.vel, ...(note.d ? { d: note.d } : {}), ...(note.band !== undefined ? { band: note.band } : {}) });
    else events.push({ type: "on", t: note.t, m: note.m, vel: note.vel, ...(note.bend ? { bend: note.bend } : {}) }, { type: "off", t: note.t + note.d, m: note.m });
  }
  return events.sort((a, b) => a.t - b.t || (a.type === "off" ? -1 : b.type === "off" ? 1 : 0));
}

// Loop length that fits what was played, so a beat repeats straight on with no dead gap:
// one typical gap after the last hit (median of the gaps between hits), or the end of the last note if later.
export function fitLength(layers) {
  const onsets = [], ends = [];
  for (const layer of layers || []) for (const event of layer.events || []) {
    if (event.type === "hit") { onsets.push(event.t); ends.push(event.t + (event.d || 0)); }
    else if (event.type === "on") onsets.push(event.t);
    else if (event.type === "off") ends.push(event.t);
  }
  if (!onsets.length) return null;
  onsets.sort((a, b) => a - b);
  const gaps = onsets.slice(1).map((t, i) => t - onsets[i]).filter(gap => gap > .03).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : .25;
  return Math.max(.05, onsets.at(-1) + gap, ...ends);
}

// Effective fades for a clip in song time. Overlapping clips on the same lane crossfade automatically:
// the overlap length becomes the minimum fade on both sides. Fades never exceed the clip together.
export function clipFades(clip, clips = [], lane = null) {
  const at = item => item.start + item.offsetMs / 1000;
  const start = at(clip), end = start + clip.length;
  let fadeIn = clip.fadeIn || 0, fadeOut = clip.fadeOut || 0;
  for (const other of clips) {
    if (other === clip || other.id === clip.id || other.lane !== clip.lane) continue;
    const oStart = at(other), oEnd = oStart + other.length;
    if (oStart < start && oEnd > start) fadeIn = Math.max(fadeIn, Math.min(oEnd, end) - start);
    if (oStart > start && oStart < end) fadeOut = Math.max(fadeOut, end - oStart);
  }
  const total = fadeIn + fadeOut;
  if (total > clip.length) { fadeIn *= clip.length / total; fadeOut *= clip.length / total; }
  return { start, end, fadeIn, fadeOut };
}
// Gain (0..1) of a clip's fade envelope at song time t.
export function fadeGainAt(f, t) {
  if (t < f.start || t > f.end) return 0;
  if (f.fadeIn && t < f.start + f.fadeIn) return (t - f.start) / f.fadeIn;
  if (f.fadeOut && t > f.end - f.fadeOut) return (f.end - t) / f.fadeOut;
  return 1;
}

// This origin contract matches design/prototype.html: start - trimStart. A slice
// changes the visible window, not the source phase. Lane loop length overrides the clip.
export function clipEvents(pattern, clip, bpm = 90, rangeStart = 0, rangeEnd = Infinity, lane = null) {
  const period = lane?.loopLength || clip.loopLength;
  const start = clip.start + clip.offsetMs / 1000, end = start + clip.length;
  const origin = start - clip.trimStart;
  const windowStart = Math.max(start, rangeStart), windowEnd = Math.min(end, rangeEnd);
  if (!(period > 0) || windowEnd <= windowStart || lane?.mute) return [];
  const output = [];
  pattern.layers.forEach((layer, layerIndex) => {
    if (layer.muted) return;
    if (layer.kind === "audio") {
      const first = Math.max(0, Math.floor((windowStart - origin) / period));
      for (let cycle = first; origin + cycle * period < windowEnd - 1e-9; cycle++) {
        const base = origin + cycle * period;
        const on = Math.max(base, windowStart), off = Math.min(base + layer.audio.duration, base + period, windowEnd);
        if (off > on + 1e-9) output.push({ type: "audio", t: on, duration: off - on, sourceOffset: on - base, layerIndex });
      }
      return;
    }
    const spans = [], held = new Map();
    const close = (event, stop) => { if (stop > event.t) spans.push({ ...event, end: stop }); };
    for (const event of [...layer.events].sort((a, b) => a.t - b.t)) {
      if (event.type === "hit") spans.push(event);
      else if (event.type === "on") {
        if (held.has(event.m)) close(held.get(event.m), event.t);
        held.set(event.m, event);
      } else if (held.has(event.m)) { close(held.get(event.m), event.t); held.delete(event.m); }
    }
    held.forEach(event => close(event, pattern.lengthSec));
    const first = Math.max(0, Math.floor((windowStart - origin) / period));
    for (let cycle = first; origin + cycle * period < windowEnd - 1e-9; cycle++) {
      const base = origin + cycle * period;
      for (const event of spans) {
        if (event.t >= period - 1e-9) continue;
        const t = base + event.t;
        if (event.type === "hit") {
          if (t >= windowStart - 1e-9 && t < windowEnd - 1e-9) output.push({ type: "hit", i: event.i, vel: event.vel, t, layerIndex, ...(event.d ? { d: event.d } : {}) });
        } else {
          const on = Math.max(t, windowStart), off = Math.min(base + event.end, base + period, windowEnd);
          if (off > on + 1e-9) output.push({ type: "on", m: event.m, vel: event.vel, t: on, sourceOffset: Math.max(0, on - t), originT: t, layerIndex, ...(event.bend ? { bend: event.bend } : {}) },
            { type: "off", m: event.m, t: off, layerIndex });
        }
      }
    }
  });
  return output.sort((a, b) => a.t - b.t || (a.type === "off" ? -1 : b.type === "off" ? 1 : 0));
}
// Notes, hits and audio of one layer as spans {t, end} in pattern time (a note held past the pattern end stops there).
function layerSpans(pattern, layer) {
  const spans = [], held = new Map();
  const close = (event, stop) => { if (stop > event.t) spans.push({ ...event, end: stop }); };
  for (const event of [...layer.events].sort((a, b) => a.t - b.t)) {
    if (event.type === "hit") spans.push(event);
    else if (event.type === "on") { if (held.has(event.m)) close(held.get(event.m), event.t); held.set(event.m, event); }
    else if (held.has(event.m)) { close(held.get(event.m), event.t); held.delete(event.m); }
  }
  held.forEach(event => close(event, pattern.lengthSec));
  return spans;
}
// Live scheduler: what STARTS inside [from, to) of song time for one clip (the player asks ~0.2 s ahead, so edits
// are heard almost at once). Notes carry their own `off` time. With includeHeld, notes/audio already sounding at
// `from` are included too, starting at `from` with a sourceOffset (used when playback starts mid-note).
export function windowEvents(pattern, clip, from, to, { lane = null, rangeEnd = Infinity, includeHeld = false } = {}) {
  const period = lane?.loopLength || clip.loopLength;
  const start = clip.start + (clip.offsetMs || 0) / 1000, end = Math.min(start + clip.length, rangeEnd), origin = start - clip.trimStart;
  const lo = Math.max(from, start), hi = Math.min(to, end);
  if (!(period > 0) || hi <= lo || lane?.mute) return [];
  const inWindow = t => t >= lo - 1e-9 && t < hi - 1e-9, output = [];
  const first = Math.max(0, Math.floor((lo - origin) / period + 1e-9));
  pattern.layers.forEach((layer, layerIndex) => {
    if (layer.muted) return;
    const spans = layer.kind === "audio" ? [{ type: "audio", t: 0, end: layer.audio.duration }] : layerSpans(pattern, layer);
    for (let cycle = first; origin + cycle * period < hi - 1e-9; cycle++) {
      const base = origin + cycle * period;
      for (const span of spans) {
        if (span.t >= period - 1e-9) continue;
        const onset = Math.max(base + span.t, start);
        if (span.type === "hit") { if (base + span.t >= start - 1e-9 && inWindow(onset)) output.push({ type: "hit", i: span.i, vel: span.vel, t: onset, layerIndex, ...(span.d ? { d: span.d } : {}) }); continue; }
        const off = Math.min(base + span.end, base + period, end);
        if (off <= onset + 1e-9) continue;
        let t = onset;
        if (!inWindow(onset)) { if (!(includeHeld && onset < lo && off > lo + 1e-9)) continue; t = lo; }
        const sourceOffset = t - (base + span.t);
        if (span.type === "audio") output.push({ type: "audio", t, duration: off - t, sourceOffset, layerIndex });
        else output.push({ type: "on", m: span.m, vel: span.vel, t, off, sourceOffset, layerIndex, ...(span.bend ? { bend: span.bend } : {}) });
      }
    }
  });
  return output.sort((a, b) => a.t - b.t);
}
export function sliceClip(clip, time) {
  const cut = time - clip.start;
  if (cut < .001 || clip.length - cut < .001) throw new Error("Slice inside the clip, away from its edges");
  return [{ ...clip, length: cut, fadeIn: Math.min(clip.fadeIn, cut), fadeOut: 0 },
    { ...clip, id: newId(), start: time, length: clip.length - cut, trimStart: clip.trimStart + cut,
      fadeIn: 0, fadeOut: Math.min(clip.fadeOut, clip.length - cut) }];
}
export function glueClips(clips, lane = null) {
  const selected = [...clips].sort((a, b) => a.start - b.start), first = selected[0];
  if (selected.length < 2) throw new Error("Shift-select two or more adjacent clips to glue");
  const period = lane?.loopLength || first.loopLength, origin = first.start - first.trimStart;
  selected.forEach((clip, i) => {
    const phase = (clip.start - clip.trimStart - origin) / period;
    if (clip.lane !== first.lane || clip.ref !== first.ref || clip.kind !== first.kind || clip.offsetMs !== first.offsetMs ||
      JSON.stringify(clip.fx) !== JSON.stringify(first.fx) ||
      Math.abs((lane?.loopLength || clip.loopLength) - period) > 1e-9 || Math.abs(phase - Math.round(phase)) > 1e-7 ||
      (i && Math.abs(selected[i - 1].start + selected[i - 1].length - clip.start) > 1e-7)) {
      throw new Error("Glue requires touching clips with the same source, lane, offset, effects, and content phase");
    }
  });
  const last = selected.at(-1);
  return { ...first, length: last.start + last.length - first.start, fadeOut: last.fadeOut };
}
export function projectData(project) {
  return { schemaVersion: 2, name: project.name, bpm: project.bpm, activePatternId: project.activePatternId,
    patterns: project.patterns.map(pattern => ({ id: pattern.id, name: pattern.name, lengthSec: pattern.lengthSec,
      ...(pattern.source ? { source: structuredClone(pattern.source) } : {}),
      layers: pattern.layers.map(layer => ({ id: layer.id,
        ...(layer.kind === "audio" ? { kind: "audio", audio: { ...layer.audio } } : { instrumentId: layer.instrumentId || layer.def.id }),
        flow: layer.flow, choke: !!layer.choke, muted: !!layer.muted,
        events: layer.events.map(({ type, t, m, i, vel, band, d }) => ({ type, t, ...(m === undefined ? {} : { m }), ...(d === undefined ? {} : { d }),
          ...(band === undefined ? {} : { band }),
          ...(i === undefined ? {} : { i }), ...(vel === undefined ? {} : { vel }) })),
      })),
    })), arrangement: structuredClone(project.arrangement) };
}

export function migrateV1(raw) {
  const n = value => { if (!Number.isFinite(value)) throw new Error("Invalid project: legacy timing"); return value; };
  if (!Array.isArray(raw.patterns) || !raw.arrangement || !Array.isArray(raw.arrangement.clips)) throw new Error("Invalid project: legacy structure");
  const spb = 60 / n(raw.bpm), a = raw.arrangement;
  const patterns = raw.patterns.map(pattern => ({ ...pattern, lengthSec: n(pattern.bars) * 4 * spb,
    layers: pattern.layers.map(layer => ({ ...layer, events: layer.events.map(event => ({ ...event, t: n(event.beat) * spb })) })) }));
  const count = n(a.lanes);
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error("Invalid project: legacy lanes");
  return { ...raw, schemaVersion: 2, patterns, arrangement: { lengthSec: n(a.bars) * 4 * spb,
    lanes: Array.from({ length: count }, (_, i) => createLane(i)), loop: { on: a.loop.enabled, start: n(a.loop.startBar) * 4 * spb, end: n(a.loop.endBar) * 4 * spb },
    clips: a.clips.map(clip => ({ id: clip.id, kind: "pattern", ref: clip.patternId, lane: clip.lane,
      start: n(clip.startBar) * 4 * spb, length: n(clip.lengthBars) * 4 * spb,
      loopLength: patterns.find(pattern => pattern.id === clip.patternId)?.lengthSec, trimStart: 0,
      fadeIn: 0, fadeOut: 0, offsetMs: clip.offsetMs })) } };
}

// Library instruments resolve by ID. Generated audio is limited to local output assets.
// Imported runtime objects and arbitrary sample/network URLs are never accepted.
export function validateProject(raw, instruments = []) {
  const fail = message => { throw new Error("Invalid project: " + message); };
  const number = (value, min, max, label, integer = false) => {
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(label);
    return value;
  };
  const text = (value, label) => { if (typeof value !== "string" || !value.trim() || value.length > 160) fail(label); return value.trim(); };
  const array = (value, max, label) => { if (!Array.isArray(value) || value.length > max) fail(label); return value; };
  const boolean = (value, label) => { if (typeof value !== "boolean") fail(label); return value; };
  if (raw?.schemaVersion === 1) raw = migrateV1(raw);
  if (!raw || raw.schemaVersion !== 2) fail("unsupported schema version");
  const catalogue = new Map(instruments.map(instrument => [instrument.id, instrument])), ids = new Set();
  let bendTotal = 0;
  const id = value => { const key = text(value, "id"); if (ids.has(key)) fail("duplicate id"); ids.add(key); return key; };
  const patterns = array(raw.patterns, 128, "patterns").map(pattern => {
    if (!pattern) fail("pattern");
    const lengthSec = number(pattern.lengthSec, .001, 3600, "pattern length");
    let source;
    if (pattern.source !== undefined) {
      const s = pattern.source;
      if (!s || !["transcription", "hum"].includes(s.kind) || !(s.kind === "hum" ? s.role === "hum" : ["melody", "bass", "drone", "percussion", "counter-line"].includes(s.role))) fail("transcription source");
      const asset = (url, extension) => {
        if (typeof url !== "string" || !new RegExp("^/output/" + (s.kind === "hum" ? "hums" : "generated") + "/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\\.(" + extension + ")$").test(url)) fail("transcription asset URL");
        return url;
      };
      let bendCount = 0;
      source = { kind: s.kind, url: asset(s.url, s.kind === "hum" ? "wav" : "mp3|wav"), midiUrl: asset(s.midiUrl, "mid"),
        ...(s.warning === undefined ? {} : { warning: text(s.warning, "source warning") }),
        ...(s.layerId === undefined ? {} : { layerId: text(s.layerId, "source layer") }),
        model: text(s.model, "transcription model"), role: s.role, mono: boolean(s.mono, "transcription mono"),
        duration: number(s.duration, .001, 3600, "source duration"),
        notes: array(s.notes, 5000, "source notes").map(note => {
          if (!note) fail("source note");
          const t = number(note.t, 0, 3600, "source note time");
          const clean = { t, d: number(note.d, .00001, 3600 - t, "source note duration"),
            m: number(note.m, 0, 127, "source MIDI note", true), vel: number(note.vel, 0, 1, "source velocity") };
          if (note.bendCents !== undefined) {
            clean.bendRate = number(note.bendRate, .001, 1000, "bend rate");
            clean.bendCents = array(note.bendCents, 360000, "pitch bends").map(cents => number(cents, -2400, 2400, "pitch bend"));
            bendCount += clean.bendCents.length; if (bendCount > 500000) fail("too many pitch bends");
          }
          return clean;
        }) };
    }
    return { id: id(pattern.id), name: text(pattern.name, "pattern name"), lengthSec,
      ...(source ? { source } : {}),
      layers: array(pattern.layers, 64, "layers").map(layer => {
        if (!layer) fail("layer");
        if (layer.kind === "audio") {
          const url = layer.audio?.url;
          if (typeof url !== "string" || !/^\/output\/(generated|imports)\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(mp3|wav)$/.test(url)) fail("audio URL");
          return { id: id(layer.id), kind: "audio", audio: { url,
            duration: number(layer.audio.duration, .001, 3600, "audio duration"),
            model: text(layer.audio.model, "audio model") },
            muted: boolean(layer.muted, "muted"), flow: 0, choke: false, events: [] };
        }
        if (layer.kind !== undefined) fail("layer kind");
        const instrumentId = text(layer.instrumentId, "instrument id"), instrument = catalogue.get(instrumentId);
        if (instruments.length && !instrument) fail("missing library instrument " + instrumentId);
        return { id: id(layer.id), instrumentId, flow: number(layer.flow, 0, 100, "flow"),
          choke: boolean(layer.choke, "choke"), muted: boolean(layer.muted, "muted"),
          events: array(layer.events, 10000, "events").map(event => {
            if (!event || !["on", "off", "hit"].includes(event.type)) fail("event type");
            const result = { type: event.type, t: number(event.t, 0, lengthSec, "event time") };
            if (event.type !== "off" && event.t === lengthSec) fail("attack at pattern end");
            if (event.type === "hit") {
              if (instrument?.kind === "melodic") fail("pad event on a keyboard instrument");
              result.i = number(event.i, 0, instrument ? instrument.pads.length - 1 : 1023, "pad", true);
              if (event.band !== undefined) result.band = number(event.band, 0, 2, "onset band", true);
              if (event.d !== undefined) result.d = number(event.d, .001, 3600, "hit hold");
            } else {
              if (instrument && instrument.kind !== "melodic") fail("note event on a pad instrument");
              result.m = number(event.m, 0, 127, "MIDI note", true);
            }
            if (event.type !== "off") result.vel = number(event.vel, 0, 1, "velocity");
            if (event.type === "on" && event.bend !== undefined) {
              const b = event.bend;
              if (!b) fail("note bend");
              result.bend = { rate: number(b.rate, .001, 1000, "bend rate"),
                cents: array(b.cents, 20000, "note bend").map(cents => number(cents, -2400, 2400, "pitch bend")) };
              bendTotal += result.bend.cents.length; if (bendTotal > 500000) fail("too many pitch bends");
            }
            return result;
          }).sort((a, b) => a.t - b.t) };
      }) };
  });
  // Projects saved before notes carried bends: copy the source curves onto the transcribed layer.
  patterns.forEach(pattern => {
    const layer = pattern.source && (pattern.layers.find(item => item.id === pattern.source.layerId) || pattern.layers[0]);
    if (layer && layer.kind !== "audio" && !layer.events.some(event => event.bend)) attachBends(layer.events, pattern.source.notes);
  });
  if (!patterns.length || !patterns.some(pattern => pattern.id === raw.activePatternId)) fail("active pattern");
  const a = raw.arrangement;
  if (!a || !a.loop) fail("arrangement");
  const lengthSec = number(a.lengthSec, .01, 3600, "song length");
  const lanes = array(a.lanes, 16, "lanes").map(lane => ({ id: id(lane.id), name: text(lane.name, "lane name"),
    ...(lane.fx === undefined ? {} : {fx:validateFx(lane.fx)}),
    mute: boolean(lane.mute, "lane mute"), solo: boolean(lane.solo, "lane solo"),
    loopLength: lane.loopLength === null ? null : number(lane.loopLength, .01, 3600, "lane loop length") }));
  if (!lanes.length) fail("lanes");
  const start = number(a.loop.start, 0, lengthSec - .001, "loop start"), end = number(a.loop.end, start + .001, lengthSec, "loop end");
  const clips = array(a.clips, 1024, "clips").map(clip => {
    if (!clip || clip.kind !== "pattern" || !patterns.some(pattern => pattern.id === clip.ref)) fail("clip pattern");
    const start = number(clip.start, 0, lengthSec - .001, "clip start"), length = number(clip.length, .001, lengthSec - start + 1e-8, "clip length");
    const fadeIn = number(clip.fadeIn, 0, length, "fade in"), fadeOut = number(clip.fadeOut, 0, length - fadeIn, "fade out");
    return { id: id(clip.id), kind: "pattern", ref: clip.ref, lane: number(clip.lane, 0, lanes.length - 1, "lane", true), start, length,
      ...(clip.fx === undefined ? {} : {fx:validateFx(clip.fx)}),
      loopLength: number(clip.loopLength, .001, 3600, "clip loop length"), trimStart: number(clip.trimStart, 0, 86400, "trim start"),
      fadeIn, fadeOut, offsetMs: number(clip.offsetMs, -1000, 1000, "clip offset") };
  });
  const markers = array(a.markers ?? [], 256, "markers").map(marker => {
    if (!marker) fail("marker");
    return { id: id(marker.id), t: number(marker.t, 0, lengthSec, "marker time"), name: text(marker.name, "marker name") };
  }).sort((x, y) => x.t - y.t);
  return { schemaVersion: 2, name: text(raw.name, "project name"), bpm: number(raw.bpm, 40, 220, "BPM"), activePatternId: raw.activePatternId,
    patterns, arrangement: { lengthSec, lanes, loop: { on: boolean(a.loop.on, "loop on"), start, end }, clips, markers } };
}

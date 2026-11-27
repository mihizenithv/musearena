import { createProject, newId, validateProject } from "./project.js";

export function defaultInstrument(instruments, role) {
  const compatible = instruments.filter(instrument => role === "percussion" ? instrument.kind !== "melodic" : instrument.kind === "melodic");
  const playable=compatible.find(instrument=>instrument.derivedFrom && (role==='melody'?/bansuri/i.test(instrument.name):role==='drone'?/tanpura/i.test(instrument.name):role==='counter-line'?/bansuri|sarangi/i.test(instrument.name):false));
  if(playable)return playable;
  if (role === "drone") {
    const tanpura = compatible.find(instrument => /tanpura/i.test(instrument.name));
    if (tanpura) return tanpura;
  }
  const prefer = ({ bass: /acoustic bass/i, drone: /tanpura|harmonium|slow strings|string ensemble/i,
    percussion: /GM Tabla/i, "counter-line": /flute/i, melody: /sitar/i })[role];
  return compatible.find(instrument => prefer?.test(instrument.name) && (role !== "percussion" || instrument.pads.length >= 3)) || compatible[0];
}

export function generatedLayer(pattern) {
  if (!pattern?.source) return null;
  return pattern.source.layerId ? pattern.layers.find(layer => layer.id === pattern.source.layerId) : pattern.layers[0];
}

export function revoicedEvents(layer, instrument, padMap = [0, 1, 2]) {
  if (!instrument || layer.kind === "audio") throw new Error("Choose a playable instrument");
  const hits = layer.events.some(event => event.type === "hit");
  if ((instrument.kind === "melodic") === hits) throw new Error("Use a keyboard instrument for notes or a pad instrument for hits");
  return layer.events.map(event => {
    if (event.type !== "hit") return { ...event };
    const band = event.band ?? Math.min(2, event.i), i = padMap[band];
    if (!Number.isInteger(i) || i < 0 || i >= instrument.pads.length) throw new Error("Choose valid low/mid/high pads");
    return { ...event, band, i };
  });
}

// Validate the backend contract before committing any mutation to the current project.
// validateProject copies each note's bend curve from source.notes onto its "on" event (attachBends).
export function patternFromTranscription(result, fields, instrument, duration, flow = 25) {
  const transcription = result.transcription;
  if (!transcription?.ok) throw new Error(transcription?.error?.message || "Transcription did not return notes");
  const percussion = fields.role === "percussion";
  if (transcription.kind !== (percussion ? "hits" : "notes")) throw new Error("Transcription kind does not match the selected role");
  if (!instrument || (instrument.kind === "melodic") === percussion) throw new Error("Choose a compatible library instrument");
  if (!Array.isArray(transcription.events) || !transcription.events.length) throw new Error("No notes or hits detected. Preview the stem, then retry transcription with different settings.");
  if (transcription.events.length > 10000) throw new Error("Transcription exceeds the pattern event limit");
  const events = transcription.events.map(event => {
    if (!event || !Number.isFinite(event.t) || event.t < 0 || event.t >= 3600) throw new Error("Invalid transcription timing");
    if (percussion) {
      if (event.type !== "hit" || !Number.isInteger(event.i) || event.i < 0 || event.i > 2) throw new Error("Invalid onset-to-pad event");
      const index = fields.padMap?.[event.i];
      if (!Number.isInteger(index) || index < 0 || index >= instrument.pads.length) throw new Error("Choose valid low/mid/high pad mappings");
      return { type: "hit", t: event.t, i: index, band: event.i, vel: event.vel };
    }
    if (!["on", "off"].includes(event.type)) throw new Error("Invalid pitched event");
    return { type: event.type, t: event.t, m: event.m, ...(event.type === "on" ? { vel: event.vel } : {}) };
  });
  // A full-length model can return far more audio than was asked for; the server transcribes only the requested
  // length and reports it, so the beat is that long (the original audio keeps its real duration for A/B).
  const limit = Number.isFinite(transcription.lengthSec) && transcription.lengthSec > 0 ? transcription.lengthSec : Infinity;
  const lengthSec = Math.max(Math.min(duration, limit), ...events.map(event => event.t + (event.type === "off" ? 0 : .001)));
  const pattern = { id: newId(), name: `${fields.role} · ${fields.genre}`.slice(0, 160), lengthSec,
    source: { kind: fields.role === "hum" ? "hum" : "transcription", url: result.audioUrl || result.url, midiUrl: transcription.midiUrl, duration,
      ...(transcription.warning ? { warning: transcription.warning.slice(0,160) } : {}),
      model: fields.model, role: fields.role, mono: !!fields.mono, notes: transcription.notes || [] },
    layers: [{ id: newId(), instrumentId: instrument.id, flow: percussion ? 0 : flow,
      choke: false, muted: false, events }] };
  pattern.source.layerId = pattern.layers[0].id;
  const candidate = createProject(); candidate.patterns = [pattern]; candidate.activePatternId = pattern.id;
  return validateProject(candidate, [instrument]).patterns[0];
}

// Piano roll for one pattern (opened from a timeline clip). Free time by default: notes stay exactly where they
// are put; snapping is opt-in and Alt bypasses it. Pad layers show one row per pad instead of piano keys.
import { eventsToNotes, notesToEvents } from "./project.js";

const $ = id => document.getElementById(id);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const KEYS_W = 56, MIN_ROW = 12;

export function mountPianoRoll({ getProject, getInstrument, onEdit, onPreview, getBpm }) {
  const panel = $("pianoRoll"), canvas = $("rollCanvas"), scroller = $("rollScroll");
  let pattern = null, layerIndex = 0, notes = [], selected = new Set(), pps = 160, drag = null, hover = null;
  let clipboard = [], cursor = 0, playTime = null;
  const layer = () => pattern?.layers[layerIndex];
  const isPads = () => layer()?.events.some(event => event.type === "hit") || getInstrument(layer())?.kind === "pads";

  function open(patternId) {
    pattern = getProject().patterns.find(item => item.id === patternId);
    if (!pattern) return;
    const playable = pattern.layers.map((l, i) => [l, i]).filter(([l]) => l.kind !== "audio");
    if (!playable.length) { $("status").textContent = `${pattern.name} has no notes to edit (audio clips use the clip tools)`; return; }
    cursor = 0; setPlayhead(null); layerIndex = playable[0][1]; selected.clear();
    panel.hidden = false; panel.dataset.pattern = pattern.id;
    $("rollLayer").replaceChildren(...playable.map(([l, i]) => {
      const option = document.createElement("option"); option.value = i;
      option.textContent = `${i + 1} · ${getInstrument(l)?.name || l.instrumentId}`; return option;
    }));
    load(); requestAnimationFrame(() => { draw(); scrollToNotes(); });
  }
  function close() { panel.hidden = true; pattern = null; }
  function load() { notes = eventsToNotes(layer().events); $("rollTitle").textContent = `PIANO ROLL · ${pattern.name}`; info(); }

  // ---- geometry
  const pads = () => getInstrument(layer())?.pads || [];
  function rows() {
    if (isPads()) return { lo: 0, hi: Math.max(pads().length, ...notes.map(n => n.i + 1), 1) - 1, pads: true };
    const ms = notes.map(n => n.m); const lo = Math.max(0, Math.min(...ms, 60) - 7), hi = Math.min(127, Math.max(...ms, lo + 24) + 7);
    return { lo, hi, pads: false };
  }
  const rowH = () => Math.max(MIN_ROW, Math.min(22, (scroller.clientHeight - 4) / (rows().hi - rows().lo + 1)));
  const width = () => Math.max(scroller.clientWidth, KEYS_W + pattern.lengthSec * pps + 40);
  const yOf = value => { const r = rows(); return (r.pads ? value - r.lo : r.hi - value) * rowH(); };
  const valueAt = y => { const r = rows(), k = Math.floor(y / rowH()); return r.pads ? Math.min(r.hi, Math.max(r.lo, r.lo + k)) : Math.min(r.hi, Math.max(r.lo, r.hi - k)); };
  const xOf = t => KEYS_W + t * pps;
  const timeAt = x => Math.max(0, (x - KEYS_W) / pps);
  const value = note => note.i ?? note.m;
  const length = note => note.d ?? (isPads() ? .12 : .25);
  function snap(t, event) {
    const step = $("rollSnap").value;
    if (!step || event?.altKey) return t;
    const size = step === "beat" ? 60 / getBpm() : step === "16th" ? 15 / getBpm() : step === "8th" ? 30 / getBpm() : +step;
    return Math.round(t / size) * size;
  }

  function draw() {
    if (!pattern) return;
    const r = rows(), rh = rowH(), w = width(), h = (r.hi - r.lo + 1) * rh, dpr = window.devicePixelRatio || 1;
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas), color = name => css.getPropertyValue(name).trim();
    g.fillStyle = color("--ink-0") || "#0A0A0A"; g.fillRect(0, 0, w, h);
    for (let v = r.lo; v <= r.hi; v++) { // rows
      const y = yOf(v), black = !r.pads && [1, 3, 6, 8, 10].includes(v % 12);
      g.fillStyle = black ? "#FFFFFF06" : "#FFFFFF0C"; g.fillRect(KEYS_W, y, w - KEYS_W, rh - 1);
    }
    const beat = 60 / getBpm(); // beat lines: a guide only
    for (let b = 0, n = 0; b <= pattern.lengthSec + 1e-6 && n < 4000; b += beat / 4, n++) {
      g.fillStyle = n % 16 === 0 ? (color("--text-3") || "#555") : n % 4 === 0 ? "#FFFFFF22" : "#FFFFFF0A";
      g.fillRect(Math.round(xOf(b)), 0, 1, h);
    }
    g.fillStyle = color("--kesar") || "#FF5A1F"; g.fillRect(Math.round(xOf(pattern.lengthSec)), 0, 2, h); // pattern end (loop point)
    for (let v = r.lo; v <= r.hi; v++) { // key / pad labels
      const y = yOf(v), black = !r.pads && [1, 3, 6, 8, 10].includes(v % 12);
      g.fillStyle = r.pads ? "#1A1A1A" : black ? "#202022" : "#D8D8DC"; g.fillRect(0, y, KEYS_W - 2, rh - 1);
      g.fillStyle = r.pads ? "#C7C7CC" : black ? "#C7C7CC" : "#111";
      g.font = `${Math.min(11, rh - 2)}px "IBM Plex Mono", monospace`; g.textBaseline = "middle";
      const label = r.pads ? (pads()[v]?.label || "Pad " + (v + 1)) : (v % 12 === 0 || rh >= 16 ? noteName(v) : "");
      g.fillText(label.slice(0, 7), 4, y + rh / 2);
    }
    notes.forEach((note, n) => {
      const x = xOf(note.t), y = yOf(value(note)), wN = Math.max(3, length(note) * pps), on = selected.has(n);
      g.fillStyle = on ? (color("--kesar") || "#FF5A1F") : "#E8E8EA"; g.globalAlpha = .35 + .65 * (note.vel ?? .8);
      g.fillRect(x, y + 1, wN, rh - 3); g.globalAlpha = 1;
      g.strokeStyle = on ? "#fff" : "#0008"; g.strokeRect(x + .5, y + 1.5, wN - 1, rh - 4);
      if (note.bend) { g.fillStyle = "#0A0A0A"; g.fillText("~", x + 3, y + rh / 2); }
    });
  }
  function info() {
    const box = $("rollInfo");
    if (selected.size !== 1) { box.hidden = true; $("rollHint").textContent = `${notes.length} note${notes.length === 1 ? "" : "s"} · double-click to add · drag to move · right edge to stretch · Del · ←→ nudge 1 ms (Shift 10) · ↑↓ pitch`; return; }
    const note = notes[[...selected][0]]; box.hidden = false;
    $("rollStart").value = (note.t * 1000).toFixed(1); $("rollLen").value = (length(note) * 1000).toFixed(1);
    $("rollVel").value = Math.round((note.vel ?? .8) * 100);
    $("rollHint").textContent = isPads() ? (pads()[note.i]?.label || "Pad " + (note.i + 1)) : noteName(note.m);
  }
  // Commit: one project edit per gesture (so playback, save and the clip preview all see it).
  function commit() {
    const end = Math.max(pattern.lengthSec, ...notes.map(note => note.t + length(note)));
    const events = notesToEvents(notes.map(note => isPads() ? note : { ...note, d: length(note) }));
    const target = pattern, index = layerIndex;
    onEdit(() => { target.layers[index].events = events; target.lengthSec = Math.min(3600, end); });
    pattern = getProject().patterns.find(item => item.id === target.id) || target;
    draw(); info();
  }
  function hitTest(x, y) {
    for (let n = notes.length - 1; n >= 0; n--) {
      const note = notes[n], nx = xOf(note.t), ny = yOf(value(note)), nw = Math.max(3, length(note) * pps);
      if (x >= nx && x <= nx + nw && y >= ny && y < ny + rowH()) return { n, edge: !isPads() && x > nx + nw - 6 };
    }
    return null;
  }
  const point = event => { const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; };

  canvas.onpointerdown = event => {
    if (event.button !== 0 || !pattern) return;
    const { x, y } = point(event);
    if (x < KEYS_W) { onPreview(layer(), valueAt(y)); return; }
    canvas.focus({ preventScroll: true });
    cursor = snap(timeAt(x), event);
    const hit = hitTest(x, y);
    if (!hit) {
      if (!event.shiftKey) selected.clear();
      drag = { box: true, x, y, base: new Set(selected) };
      canvas.setPointerCapture(event.pointerId); draw(); info(); return;
    }
    if (event.shiftKey) selected.has(hit.n) ? selected.delete(hit.n) : selected.add(hit.n);
    else if (!selected.has(hit.n)) { selected.clear(); selected.add(hit.n); }
    onPreview(layer(), value(notes[hit.n]), notes[hit.n].vel);
    canvas.setPointerCapture(event.pointerId);
    drag = { x, y, edge: hit.edge, moved: false, start: [...selected].map(n => ({ n, t: notes[n].t, v: value(notes[n]), d: length(notes[n]) })) };
    draw(); info();
  };
  canvas.onpointermove = event => {
    const { x, y } = point(event);
    if (!drag) { const hit = hitTest(x, y); canvas.style.cursor = hit?.edge ? "ew-resize" : hit ? "grab" : x < KEYS_W ? "pointer" : "crosshair"; return; }
    if (drag.box) {
      const left = Math.min(x,drag.x), top = Math.min(y,drag.y), right = Math.max(x,drag.x), bottom = Math.max(y,drag.y);
      selected = new Set(drag.base);
      notes.forEach((n,i) => {
        if (xOf(n.t) <= right && xOf(n.t + length(n)) >= left && yOf(value(n)) <= bottom && yOf(value(n))+rowH() >= top) selected.add(i);
      });
      draw(); info();
      const g = canvas.getContext("2d"); g.strokeStyle = "#ff5a1f"; g.strokeRect(left,top,right-left,bottom-top); return;
    }
    const dt = (x - drag.x) / pps, dv = Math.round((drag.y - y) / rowH()) * (rows().pads ? -1 : 1);
    if (!drag.moved && Math.abs(x - drag.x) + Math.abs(y - drag.y) < 3) return;
    drag.moved = true;
    const r = rows();
    for (const s of drag.start) {
      const note = notes[s.n];
      if (drag.edge) note.d = Math.max(.005, snap(s.t + s.d + dt, event) - s.t);
      else {
        note.t = Math.max(0, snap(s.t + dt, event));
        const v = Math.min(r.hi, Math.max(r.lo, s.v + dv)); if (note.i !== undefined) note.i = v; else note.m = v;
      }
    }
    draw(); info();
  };
  canvas.onpointerup = () => { if (drag?.moved) commit(); drag = null; draw(); };
  canvas.ondblclick = event => {
    const { x, y } = point(event); if (x < KEYS_W || hitTest(x, y)) return;
    const t = snap(timeAt(x), event), v = valueAt(y), last = notes.at(-1);
    notes.push(isPads() ? { t, i: v, vel: last?.vel ?? .8 } : { t, d: last?.d ?? 60 / getBpm() / 2, m: v, vel: last?.vel ?? .8 });
    selected = new Set([notes.length - 1]); onPreview(layer(), v); commit();
  };
  panel.onkeydown = event => {
    if (!pattern || event.target.closest("input, select")) return;
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "c" && selected.size) {
        clipboard = [...selected].map(i => structuredClone(notes[i]));
        event.preventDefault(); return;
      }
      if (key === "v" && clipboard.length && (clipboard[0].i !== undefined) === !!isPads()) {
        const origin = Math.min(...clipboard.map(n => n.t)), start = playTime ?? cursor;
        const copies = clipboard.map(n => ({ ...structuredClone(n), t: start + n.t - origin }));
        if (copies.some(n => n.t + length(n) > 3600)) return;
        selected = new Set(copies.map((_,i) => notes.length + i));
        notes.push(...copies); event.preventDefault(); commit(); return;
      }
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selected.size) {
      event.preventDefault(); notes = notes.filter((_, n) => !selected.has(n)); selected.clear(); commit(); return;
    }
    const step = event.shiftKey ? .01 : .001, r = rows();
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, r.pads ? -1 : 1], ArrowDown: [0, r.pads ? 1 : -1] }[event.key];
    if (moves && selected.size) {
      event.preventDefault();
      for (const n of selected) {
        const note = notes[n]; note.t = Math.max(0, note.t + moves[0]);
        if (moves[1]) { const v = Math.min(r.hi, Math.max(r.lo, value(note) + moves[1])); if (note.i !== undefined) note.i = v; else note.m = v; }
      }
      commit();
    }
    if (event.key === "Escape") close();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); selected = new Set(notes.map((_, n) => n)); draw(); info(); }
  };
  const field = (id, apply) => { $(id).onchange = () => { const note = notes[[...selected][0]]; if (note) { apply(note, +$(id).value); commit(); } }; };
  field("rollStart", (note, ms) => { note.t = Math.max(0, ms / 1000); });
  field("rollLen", (note, ms) => { note.d = Math.max(.005, ms / 1000); });
  field("rollVel", (note, pct) => { note.vel = Math.min(1, Math.max(.01, pct / 100)); });
  $("rollLayer").onchange = () => { layerIndex = +$("rollLayer").value; selected.clear(); load(); draw(); };
  $("rollSnap").onchange = () => draw();
  $("rollZoomIn").onclick = () => { pps = Math.min(1200, pps * 1.25); draw(); };
  $("rollZoomOut").onclick = () => { pps = Math.max(20, pps / 1.25); draw(); };
  $("rollClose").onclick = close;
  function scrollToNotes() { if (notes.length) scroller.scrollTop = Math.max(0, yOf(Math.max(...notes.map(value))) - 20); }
  new ResizeObserver(() => draw()).observe(scroller);
  function setPlayhead(time, mode, activeId) {
    if (!pattern || panel.hidden) return;
    playTime = time;
    if (time !== null && mode === "song") {
      const a = getProject().arrangement;
      const clip = a.clips.find(c => c.ref === pattern.id && !a.lanes[c.lane]?.mute &&
        time >= c.start + c.offsetMs / 1000 && time < c.start + c.offsetMs / 1000 + c.length);
      playTime = clip ? (time - clip.start - clip.offsetMs / 1000 + clip.trimStart) % (a.lanes[clip.lane]?.loopLength || clip.loopLength) : null;
    } else if (activeId !== pattern.id) playTime = null;
    const marker = $("rollPlayhead");
    marker.hidden = playTime === null;
    if (!marker.hidden) {
      marker.style.left = xOf(playTime) + "px";
      marker.style.height = canvas.style.height;
    }
  }
  return { open, close, setPlayhead, isOpen: () => !panel.hidden, refresh: () => { if (pattern) { pattern = getProject().patterns.find(item => item.id === pattern.id); if (!pattern) close(); else { selected.clear(); load(); draw(); } } } };
}

// Step grid (Beat Maker view): FL-style rows x 16th-note steps over the CURRENT beat's own events.
// A lit cell = an event that starts within half a step of that step; its offset is kept and shown (never quantised).
// Click toggles a hit exactly on the step; Alt+drag a lit cell nudges it in ms (up to half a step either way).
const $ = id => document.getElementById(id);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);

export function mountStepGrid({ getPattern, getInstrument, getCurrent, getBpm, getVelocity, getOctave, onEdit, onPreview }) {
  const root = $("stepGrid"), body = $("stepRows");
  let extraRows = []; // rows added with "+ ROW" that have no events yet: {instrumentId, value}
  const stepLen = () => 15 / getBpm(); // a 16th note
  const stepsIn = pattern => Math.max(1, Math.min(256, Math.round(pattern.lengthSec / stepLen())));

  function rowsOf(pattern) {
    const rows = new Map();
    pattern.layers.forEach((layer, li) => {
      if (layer.kind === "audio") return;
      for (const event of layer.events) {
        if (event.type === "off") continue;
        const value = event.type === "hit" ? event.i : event.m, key = layer.instrumentId + ":" + value;
        if (!rows.has(key)) rows.set(key, { instrumentId: layer.instrumentId, value, pads: event.type === "hit" });
      }
    });
    for (const row of extraRows) { const key = row.instrumentId + ":" + row.value; if (!rows.has(key)) rows.set(key, row); }
    return [...rows.values()].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId) || (a.pads ? a.value - b.value : b.value - a.value));
  }
  // events on a row near a step: [{layer, event}]
  function cellEvents(pattern, row, step) {
    const t0 = step * stepLen(), half = stepLen() / 2, found = [];
    for (const layer of pattern.layers) {
      if (layer.kind === "audio" || layer.instrumentId !== row.instrumentId) continue;
      for (const event of layer.events) {
        if (event.type === "off" || (event.type === "hit" ? event.i : event.m) !== row.value) continue;
        if (event.t >= t0 - half && event.t < t0 + half) found.push({ layer, event });
      }
    }
    return found;
  }
  function layerFor(pattern, instrumentId) {
    let layer = pattern.layers.find(item => item.kind !== "audio" && item.instrumentId === instrumentId);
    if (!layer) {
      const def = getInstrument(instrumentId);
      layer = { id: crypto.randomUUID(), instrumentId, def, flow: 25, choke: false, muted: false, events: [] };
      pattern.layers.push(layer);
    }
    return layer;
  }
  function toggle(row, step) {
    const pattern = getPattern(), found = cellEvents(pattern, row, step);
    onEdit(() => {
      if (found.length) {
        for (const { layer, event } of found) {
          layer.events = layer.events.filter(item => item !== event);
          if (event.type === "on") { // remove its matching release too
            const off = layer.events.filter(item => item.type === "off" && item.m === event.m && item.t >= event.t).sort((a, b) => a.t - b.t)[0];
            if (off) layer.events = layer.events.filter(item => item !== off);
          }
        }
      } else {
        const layer = layerFor(pattern, row.instrumentId), t = step * stepLen(), vel = getVelocity();
        if (row.pads) layer.events.push({ type: "hit", t, i: row.value, vel });
        else layer.events.push({ type: "on", t, m: row.value, vel }, { type: "off", t: Math.min(pattern.lengthSec, t + stepLen() * .95), m: row.value });
        layer.events.sort((a, b) => a.t - b.t);
        onPreview(row, vel);
      }
    });
  }
  function nudge(row, step, ms) {
    const pattern = getPattern(), found = cellEvents(pattern, row, step);
    if (!found.length) return;
    onEdit(() => {
      for (const { layer, event } of found) {
        const limit = stepLen() / 2 - .0005, base = step * stepLen();
        const next = Math.max(0, Math.min(pattern.lengthSec - .001, Math.max(base - limit, Math.min(base + limit, event.t + ms / 1000))));
        if (event.type === "on") {
          const off = layer.events.filter(item => item.type === "off" && item.m === event.m && item.t >= event.t).sort((a, b) => a.t - b.t)[0];
          if (off) off.t = Math.min(pattern.lengthSec, off.t + (next - event.t));
        }
        event.t = next;
      }
    });
  }

  // Playhead: a line that moves at the exact playback time (not snapped to steps) over a beat ruler.
  const playhead = document.createElement("div"); playhead.className = "step-playhead"; playhead.hidden = true; playhead.setAttribute("aria-hidden", "true");
  function ruler(steps) {
    const line = document.createElement("div"); line.className = "step-row step-ruler"; line.setAttribute("aria-hidden", "true");
    const head = document.createElement("div"); head.className = "step-head step-ruler-head"; head.textContent = "BAR.BEAT"; line.appendChild(head);
    for (let step = 0; step < steps; step++) {
      const cell = document.createElement("div"); cell.className = "ruler-cell" + (step % 4 === 0 ? " beat" : ""); cell.dataset.step = step;
      if (step % 4 === 0) cell.textContent = `${Math.floor(step / 16) + 1}.${(step / 4) % 4 + 1}`;
      line.appendChild(cell);
    }
    line.appendChild(document.createElement("span"));
    return line;
  }
  function render() {
    if (root.offsetParent === null) return; // only drawn when the Beat Maker view shows it
    const pattern = getPattern(), steps = stepsIn(pattern), rows = rowsOf(pattern);
    $("stepTitle").textContent = `STEP GRID · ${pattern.name} · ${steps} steps (1/16)`;
    body.style.setProperty("--steps", steps);
    body.replaceChildren(ruler(steps), playhead, ...rows.map(row => {
      const def = getInstrument(row.instrumentId);
      const line = document.createElement("div"); line.className = "step-row";
      const head = document.createElement("div"); head.className = "step-head";
      head.textContent = `${def?.name || row.instrumentId} · ${row.pads ? (def?.pads?.[row.value]?.label || "Pad " + (row.value + 1)) : noteName(row.value)}`;
      head.title = head.textContent + " — click to hear";
      head.onclick = () => onPreview(row, getVelocity());
      line.appendChild(head);
      for (let step = 0; step < steps; step++) {
        const cell = document.createElement("button"); cell.type = "button"; cell.className = "step" + (step % 4 === 0 ? " beat" : "");
        const found = cellEvents(pattern, row, step);
        if (found.length) {
          const offset = (found[0].event.t - step * stepLen()) * 1000;
          cell.classList.add("on"); cell.style.setProperty("--vel", found[0].event.vel ?? .8);
          if (Math.abs(offset) >= .5) { cell.classList.add("nudged"); cell.style.setProperty("--nudge", Math.max(-1, Math.min(1, offset / (stepLen() * 500)))); }
          cell.title = `step ${step + 1} · ${offset >= 0 ? "+" : ""}${offset.toFixed(1)} ms · Alt+drag to nudge`;
        } else cell.title = `step ${step + 1}`;
        cell.setAttribute("aria-pressed", String(found.length > 0));
        cell.setAttribute("aria-label", `${head.textContent}, step ${step + 1}`);
        cell.dataset.step = step;
        cell.onpointerdown = event => {
          if (event.button !== 0) return;
          if (event.altKey && found.length) { // Alt+drag: nudge in ms
            event.preventDefault(); const x0 = event.clientX; let last = 0;
            const move = ev => { const ms = Math.round((ev.clientX - x0) * 0.5); cell.title = `${ms >= 0 ? "+" : ""}${ms} ms`; last = ms; };
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); if (last) nudge(row, step, last); };
            window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
            return;
          }
          toggle(row, step);
        };
        line.appendChild(cell);
      }
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "step-del"; remove.textContent = "×";
      remove.title = "Remove this row (and its hits)"; remove.setAttribute("aria-label", `Remove row ${head.textContent}`);
      remove.onclick = () => {
        extraRows = extraRows.filter(item => !(item.instrumentId === row.instrumentId && item.value === row.value));
        onEdit(() => { for (const layer of getPattern().layers) if (layer.instrumentId === row.instrumentId)
          layer.events = layer.events.filter(event => (event.type === "hit" ? event.i : event.m) !== row.value); });
      };
      line.appendChild(remove);
      return line;
    }));
    $("stepEmpty").hidden = rows.length > 0;
  }
  $("stepAddRow").onclick = () => {
    const def = getCurrent(); if (!def) return;
    const used = new Set(rowsOf(getPattern()).filter(row => row.instrumentId === def.id).map(row => row.value));
    let value;
    if (def.kind === "melodic") { value = 12 * (getOctave() + 1); while (used.has(value) && value < 127) value++; }
    else { value = 0; while (used.has(value) && value < def.pads.length - 1) value++; }
    extraRows.push({ instrumentId: def.id, value, pads: def.kind !== "melodic" });
    render();
  };
  $("stepAddKit").onclick = () => { // a row for every pad of the current kit (up to 16)
    const def = getCurrent(); if (!def || def.kind === "melodic") return;
    def.pads.slice(0, 16).forEach((_, value) => extraRows.push({ instrumentId: def.id, value, pads: true }));
    render();
  };
  let lastStep = -1;
  function setPlayhead(fraction) {
    if (fraction === null || root.offsetParent === null) {
      playhead.hidden = true; lastStep = -1;
      body.querySelectorAll(".now").forEach(cell => cell.classList.remove("now"));
      return;
    }
    const steps = stepsIn(getPattern()), f = Math.max(0, Math.min(1, fraction));
    const first = body.querySelector('.ruler-cell[data-step="0"]'), last = body.querySelector(`.ruler-cell[data-step="${steps - 1}"]`);
    if (!first || !last) return;
    const origin = body.getBoundingClientRect().left - body.scrollLeft; // measure against the scrolling grid, not the sticky ruler
    const x0 = first.getBoundingClientRect().left - origin, x1 = last.getBoundingClientRect().right - origin, x = x0 + f * (x1 - x0);
    playhead.hidden = false; playhead.style.transform = `translateX(${x}px)`;
    if (x > body.scrollLeft + body.clientWidth - 40 || x < body.scrollLeft + x0) body.scrollLeft = Math.max(0, x - x0 - 40); // follow long beats
    const step = Math.min(steps - 1, Math.floor(f * steps));
    if (step !== lastStep || !body.querySelector(".now")) { // light the current column (cheap: only when the step changes)
      body.querySelectorAll(".now").forEach(cell => cell.classList.remove("now"));
      body.querySelectorAll(`[data-step="${step}"]`).forEach(cell => cell.classList.add("now"));
      lastStep = step;
    }
  }
  return { render, setPlayhead, reset: () => { extraRows = []; render(); } };
}

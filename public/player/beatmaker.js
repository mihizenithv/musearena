// Beat maker: make a beat in the player, then drag it to the timeline.
// The beat view shows the LIVE TAKE (whatever you just played, captured without REC) or, when there is none,
// the current pattern. Both can be dragged onto a timeline lane. Pure UI: audio/recording live in app.js.
const $ = id => document.getElementById(id);

export function mountBeatMaker({ getPattern, getState, onPlay, onHum, onCapture, onClearLive, onPlayLive, onToggleArm, onNew, onToTimeline }) {
  const view = $("beatView"), canvas = $("beatRoll"), head = $("beatPlayhead");
  $("beatPlay").onclick = onPlay; $("beatHum").onclick = onHum;
  $("livePlay").onclick = event => { event.stopPropagation(); onPlayLive(); };
  $("liveRec").onclick = event => { event.stopPropagation(); onToggleArm(); };
  $("beatNew").onclick = onNew; $("beatToTimeline").onclick = onToTimeline;
  $("liveKeep").onclick = event => { event.stopPropagation(); onCapture(); };
  $("liveClear").onclick = event => { event.stopPropagation(); onClearLive(); };

  // Wide screens: the view fills the empty space beside the instrument name. Narrow: it sits in the beat-maker row.
  const wide = matchMedia("(min-width: 1251px)");
  const place = () => (wide.matches ? $("liveSlotWide") : $("liveSlotNarrow")).appendChild(view);
  wide.addEventListener("change", () => { place(); render(); }); place();

  let showingLive = false, previewing = false;
  view.ondragstart = event => {
    if (showingLive) event.dataTransfer.setData("application/x-muse-take", "live");
    else event.dataTransfer.setData("application/x-muse-pattern", getPattern().id);
    event.dataTransfer.effectAllowed = "copy";
    document.body.classList.add("dragging-beat");
  };
  view.ondragend = () => document.body.classList.remove("dragging-beat");

  const label = (id, text, pressed) => {
    const button = $(id); button.querySelector("span").textContent = text;
    if (pressed !== undefined) { button.setAttribute("aria-pressed", String(pressed)); button.classList.toggle("on", pressed); }
  };

  function draw(pattern) {
    const dpr = window.devicePixelRatio || 1, width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, width, height);
    const css = getComputedStyle(canvas), color = name => css.getPropertyValue(name).trim();
    const length = pattern.lengthSec || 1, x = t => (t / length) * width;
    // beat grid is only a visual guide: notes stay exactly where they were played
    const { bpm } = getState(), beat = 60 / (bpm || 90);
    for (let b = 0, n = 0; b < length - 1e-6 && n < 512; b += beat, n++) {
      g.fillStyle = n % 4 === 0 ? color("--rule") || "#333" : "#FFFFFF0D";
      g.fillRect(Math.round(x(b)), 0, 1, height);
    }
    const notes = [], hits = [];
    pattern.layers.forEach((layer, index) => {
      if (layer.kind === "audio") { notes.push({ audio: true, t: 0, d: Math.min(length, layer.audio.duration), index }); return; }
      const open = new Map();
      for (const event of layer.events) {
        if (event.type === "hit") hits.push({ t: event.t, i: event.i, d: event.d, index });
        else if (event.type === "on") open.set(event.m, event);
        else if (open.has(event.m)) { const on = open.get(event.m); notes.push({ t: on.t, d: Math.max(.02, event.t - on.t), m: on.m, index }); open.delete(event.m); }
      }
      open.forEach(on => notes.push({ t: on.t, d: Math.max(.02, length - on.t), m: on.m, index, live: true }));
    });
    const pitched = notes.filter(note => !note.audio);
    const lo = Math.min(...pitched.map(n => n.m), 60) - 1, hi = Math.max(...pitched.map(n => n.m), 72) + 1;
    const row = (height - 4) / (hi - lo + 1), palette = [color("--kesar") || "#FF5A1F", "#E8E8EA", "#7FB2FF", "#9BE39B", "#E58BD6"];
    for (const note of notes) {
      g.fillStyle = palette[note.index % palette.length];
      if (note.audio) { g.globalAlpha = .25; g.fillRect(x(note.t), 2, Math.max(2, x(note.d) - x(note.t)), height - 4); g.globalAlpha = 1; continue; }
      g.globalAlpha = note.live ? .55 : 1;
      g.fillRect(x(note.t), height - 2 - (note.m - lo + 1) * row, Math.max(2, (note.d / length) * width), Math.max(2, row - 1));
      g.globalAlpha = 1;
    }
    const rows = Math.max(4, Math.min(16, Math.max(0, ...hits.map(hit => hit.i)) + 1)), rowH = (height - 4) / rows;
    for (const hit of hits) {
      g.fillStyle = palette[hit.index % palette.length];
      const barH = Math.max(3, Math.min(8, rowH - 2)), y = 2 + (hit.i % rows) * rowH + (rowH - barH) / 2;
      g.fillRect(x(hit.t) - 1, y, Math.max(3, hit.d ? (hit.d / length) * width : 3), barH);
    }
    return { notes: pitched.length + hits.length, audio: notes.some(note => note.audio) };
  }

  function render() {
    const state = getState(), live = state.live;
    showingLive = !!live;
    const pattern = live || getPattern(), info = draw(pattern);
    view.classList.toggle("live", showingLive);
    label("beatPlay", state.playingPattern ? "STOP" : "PLAY BEAT", state.playingPattern);
    $("beatPlay").querySelector("use").setAttribute("href", state.playingPattern ? "#i-stop" : "#i-play");
    label("beatHum", state.humming ? "STOP HUM" : "HUM", state.humming);
    $("beatHum").disabled = state.humBlocked;
    $("liveKeep").hidden = $("liveClear").hidden = $("livePlay").hidden = !showingLive;
    $("livePlay").innerHTML = state.previewing ? '<svg class="i" aria-hidden="true"><use href="#i-stop"/></svg> STOP' : '<svg class="i" aria-hidden="true"><use href="#i-play"/></svg> PLAY';
    $("liveRec").setAttribute("aria-checked", String(state.armed)); $("liveRec").classList.toggle("armed", state.armed);
    $("liveRec").title = state.armed ? "RECORD on: whatever you play is kept here. Switch off to play without keeping." : "RECORD off: playing is not kept. Switch on to record.";
    view.classList.toggle("armed", state.armed); previewing = state.previewing;
    $("beatTitle").textContent = showingLive ? "LIVE TAKE" : pattern.name.toUpperCase();
    if (showingLive) {
      $("beatInfo").textContent = `${info.notes} note${info.notes === 1 ? "" : "s"} · ${live.span.toFixed(2)} s · drag onto a lane`;
    } else {
      const where = state.onTimeline ? `on timeline ×${state.onTimeline}` : "drag onto a lane";
      $("beatInfo").textContent = info.notes || info.audio ? `${info.audio && !info.notes ? "audio" : `${info.notes} note${info.notes === 1 ? "" : "s"}`} · ${pattern.lengthSec.toFixed(2)} s · ${where}`
        : state.armed ? "Just play: your notes appear here" : "RECORD is off: switch it on to keep what you play";
    }
    view.setAttribute("aria-label", `${$("beatTitle").textContent}: ${$("beatInfo").textContent}`);
  }
  function setPlayhead(fraction) {
    head.hidden = fraction === null || (showingLive && !previewing);
    if (fraction !== null) head.style.left = Math.max(0, Math.min(1, fraction)) * 100 + "%";
  }
  new ResizeObserver(() => render()).observe(canvas);
  return { render, setPlayhead };
}

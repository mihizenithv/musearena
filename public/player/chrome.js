// Shell controls added with the 2026-11 redesign: transport STOP and RECORD, the header save/help buttons and the
// sidebar GENERATE A TUNE button. Each one drives an existing control, so app.js keeps a single code path.
const $ = id => document.getElementById(id);
const isPlaying = () => $("playBtn").getAttribute("aria-pressed") === "true";

export function mountChrome() {
  // STOP: stops playback; pressing it again while stopped returns to the start (the usual DAW double-stop).
  $("stopBtn").onclick = () => {
    if (isPlaying()) $("playBtn").click();
    else $("rewindBtn").click();
    $("stemPreview")?.pause?.();
  };

  // RECORD in the transport mirrors the live-take RECORD switch (one state, two places to reach it).
  const liveRec = $("liveRec"), recArm = $("recArm");
  const syncRec = () => {
    const armed = liveRec.getAttribute("aria-checked") === "true";
    recArm.setAttribute("aria-pressed", String(armed));
    recArm.title = armed ? "RECORD on: what you play is kept in the live take. Click to pause." : "RECORD off: playing is not kept. Click to record.";
  };
  recArm.onclick = () => liveRec.click();
  new MutationObserver(syncRec).observe(liveRec, { attributes: true, attributeFilter: ["aria-checked"] });
  syncRec();

  // Save: autosave state on the cloud icon; a click (or Ctrl+S) downloads the project JSON.
  const dot = $("saveDot"), quick = $("quickSave");
  const labels = { pending: "Saving in this browser…", saved: "Autosaved in this browser", failed: "Autosave failed: this browser's storage is full or blocked. Use SAVE JSON." };
  document.addEventListener("musearena:autosave", event => {
    const state = event.detail?.state || "saved";
    dot.dataset.state = state;
    quick.title = labels[state] + ". Click to download the project as JSON (Ctrl+S)";
  });
  quick.onclick = () => $("saveProject").click();
  window.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault(); $("saveProject").click();
    }
  });

  // Shortcuts panel: ? button or the ? key (outside text fields); Escape or a click outside closes it.
  const help = $("helpPanel"), helpBtn = $("helpBtn");
  const setHelp = open => {
    help.hidden = !open; helpBtn.setAttribute("aria-expanded", String(open));
    if (open) $("helpClose").focus(); else if (help.contains(document.activeElement)) helpBtn.focus();
  };
  helpBtn.onclick = () => setHelp(help.hidden);
  $("helpClose").onclick = () => setHelp(false);
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !help.hidden) { setHelp(false); return; }
    if (event.key === "?" && !event.target.closest?.("input, select, textarea, [contenteditable=true]")) { event.preventDefault(); setHelp(help.hidden); }
    if (event.key === "Home" && !event.target.closest?.("input, select, textarea, [contenteditable=true], #pianoRoll, .timeline-scroll, [role=slider]")) { event.preventDefault(); $("rewindBtn").click(); }
  });
  document.addEventListener("pointerdown", event => {
    if (!help.hidden && !help.contains(event.target) && !helpBtn.contains(event.target)) setHelp(false);
  });

  $("editClipNotes").onclick = () => $("openRoll").click();

  // Sidebar call to action: the AI tab holds the generator.
  $("genTuneCta").onclick = () => {
    document.querySelector('[data-view-tab="ai"]').click();
    $("generatePanel").open = true;
    requestAnimationFrame(() => $("generatePrompt")?.focus());
  };
}

// Range sliders show their filled part in the accent colour (CSS reads --fill). Values also change from code
// (switching layer or instrument), so a light poll keeps the fill honest without hooking every setter.
export function mountRangeFill() {
  const paint = el => { const min = +el.min || 0, max = +el.max || 100, v = +el.value; el.style.setProperty("--fill", ((v - min) / (max - min || 1) * 100).toFixed(1) + "%"); };
  const all = () => document.querySelectorAll("input[type=range]").forEach(paint);
  document.addEventListener("input", event => { if (event.target.matches?.("input[type=range]")) paint(event.target); });
  setInterval(all, 400); all();
}

// Overview tune strip: a second "PLAY IT ON" picker that mirrors the generator's instrument choice, so the tune can
// be re-voiced with one click while the song plays, without leaving Overview.
export function mountTuneStrip() {
  // Where the tune controls live: in the AI tab, under the form as before; elsewhere, in the player header bar.
  const result = $("generatedResult"), takes = $("generateTakes"), strip = $("tuneStrip");
  const home = result.parentElement, homeNext = takes.nextElementSibling; // generator section, before the form
  const place = () => {
    if (document.body.dataset.view === "ai") { if (result.parentElement !== home) home.insertBefore(result, homeNext), home.insertBefore(takes, homeNext); }
    else if (result.parentElement !== strip) strip.append(result, takes);
  };
  new MutationObserver(place).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  place();

  const source = $("generateInstrument"), mirror = $("stripInstrument");
  const copyOptions = () => { mirror.replaceChildren(...[...source.options].map(option => option.cloneNode(true))); mirror.value = source.value; };
  new MutationObserver(copyOptions).observe(source, { childList: true });
  copyOptions();
  setInterval(() => { // value and disabled are set from code (revoice, project load); keep the mirror in step
    if (mirror.value !== source.value) mirror.value = source.value;
    mirror.disabled = source.disabled;
  }, 300);
  let stripActionAt = -Infinity; // the header only repeats generator messages that follow a strip action
  mirror.onchange = () => { stripActionAt = performance.now(); source.value = mirror.value; source.dispatchEvent(new Event("change")); };
  // Generator messages are written inside the AI form; outside the AI tab they show in the tune strip, and in the header right after a PLAY IT ON change.
  const genStatus = $("generateStatus"), status = $("status");
  new MutationObserver(() => {
    const text = genStatus.textContent.trim();
    const error = genStatus.classList.contains("error");
    $("stripStatus").textContent = text; $("stripStatus").classList.toggle("error", error);
    if (text && document.body.dataset.view !== "ai" && performance.now() - stripActionAt < 8000) { status.textContent = text; status.classList.toggle("error", error); }
  }).observe(genStatus, { childList: true, characterData: true, subtree: true });
}

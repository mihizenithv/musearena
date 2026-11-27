import { createPattern, createLane, duplicatePattern, newId, snapTime, sliceClip, glueClips, clipFades, clipEvents } from "./project.js";

const $ = id => document.getElementById(id);
const LANE_HEIGHT = 58, RULER_HEIGHT = 29, HEAD_WIDTH = 150, MAX_SONG = 3600, HEADROOM = 8;
// One flat colour per lane (cycles); clips inherit it through the --lane custom property.
const LANE_COLORS = ["#FF5A1F", "#2F4BFF", "#7A5CFF", "#00A870", "#E8B400", "#E0306B"];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function mountArrangement({ getProject, onEdit, onUndo = () => {}, onPatternSelect, onOpenPattern, onSave, onLoad, onSelection = () => {}, onJump = () => {}, onDropFiles = () => {}, onDropTake = () => {} }) {
  let selectedClipId = null, selectedIds = new Set(), pps = 80, tool = "select", cursor = 0;
  let lastPatternTap = null, lastClipTap = null;
  let selectedLane = null, clipboard = null;
  const scroll = $("timelineScroll"), follow = $("followPlayhead");
  let following = true, suspended = false, autoScrollLeft = scroll.scrollLeft;
  follow.onclick = () => {
    following = !following; suspended = false;
    follow.setAttribute("aria-pressed", String(following));
  };
  scroll.addEventListener("scroll", () => {
    if ($("songPlayhead")?.classList.contains("playing") && scroll.scrollLeft !== autoScrollLeft) suspended = true;
    autoScrollLeft = scroll.scrollLeft;
  });
  const selected = () => getProject().arrangement.clips.find(clip => clip.id === selectedClipId);
  const step = () => +$("snap").value || .01;
  const snap = (value, event) => snapTime(value, +$("snap").value, !!event?.altKey);
  // The song grows to hold every clip (BUGS.md A9): a clip may be dropped, moved, stretched or duplicated past the
  // current end; the song then ends at the next whole second after the last clip. Empty grid is drawn past the end
  // (HEADROOM) so there is somewhere to drag to.
  const growSong = a => { const end = Math.max(0, ...a.clips.map(clip => clip.start + clip.length)); if (end > a.lengthSec + 1e-9) a.lengthSec = Math.min(MAX_SONG, Math.ceil(end - 1e-9)); };
  let dragEnd = 0;
  const canvasEnd = a => Math.min(MAX_SONG, Math.max(dragEnd, a.lengthSec + HEADROOM));
  const edit = mutation => onEdit(project => { mutation(project); growSong(project.arrangement); });
  const timeAt = event => Math.max(0, Math.min(canvasEnd(getProject().arrangement),
    (event.clientX - $("timeline").getBoundingClientRect().left - HEAD_WIDTH) / pps));
  const report = message => { $("status").textContent = message; };
  // Clicking a lane only selects it (ADD CLIP / ADD TO TIMELINE go there); clicking its empty space also moves the
  // cursor. It never creates a pattern or changes PATTERN/SONG (BUGS.md A5).
  function chooseLane(index, event = null) {
    selectedLane = index; selectedClipId = null; selectedIds.clear();
    if (event) { cursor = clamp(snap(timeAt(event), event), 0, getProject().arrangement.lengthSec); onJump(cursor, { soft: true }); }
    render(); setPlayhead(null);
    report(`${getProject().arrangement.lanes[index].name} selected` + (event ? ` · cursor ${cursor.toFixed(3)} s` : ""));
  }
  function selectClip(clip, event = {}) {
    if (!event.shiftKey) selectedIds.clear();
    if (event.shiftKey && selectedIds.has(clip.id)) selectedIds.delete(clip.id); else selectedIds.add(clip.id);
    selectedClipId = clip.id;
  }

  // Deleting is one click, so every delete shows an UNDO button for 10 s. It (and Ctrl+Z, any time) uses the
  // project-wide undo history in app.js.
  let undoTimer = null;
  function offerUndo(message) {
    report(message);
    const toast = $("undoToast"); toast.querySelector("span").textContent = message; toast.hidden = false;
    clearTimeout(undoTimer); undoTimer = setTimeout(() => { toast.hidden = true; }, 10000);
  }
  $("undoBtn").onclick = () => { $("undoToast").hidden = true; clearTimeout(undoTimer); onUndo(); };
  function deletePattern(id) {
    const project = getProject(), index = project.patterns.findIndex(pattern => pattern.id === id);
    if (index < 0) return;
    const pattern = project.patterns[index], clips = project.arrangement.clips.filter(clip => clip.ref === id), previous = project.activePatternId;
    let placeholder = null;
    edit(project => {
      project.patterns.splice(index, 1);
      project.arrangement.clips = project.arrangement.clips.filter(clip => clip.ref !== id);
      if (!project.patterns.length) { placeholder = createPattern("Pattern 01", 4 * 60 / project.bpm); project.patterns.push(placeholder); }
      if (previous === id) project.activePatternId = project.patterns[Math.min(index, project.patterns.length - 1)].id;
      selectedIds = new Set([...selectedIds].filter(clipId => !clips.some(clip => clip.id === clipId)));
      if (clips.some(clip => clip.id === selectedClipId)) selectedClipId = null;
    });
    offerUndo(`Deleted ${pattern.name}${clips.length ? ` and its ${clips.length} clip${clips.length > 1 ? "s" : ""}` : ""}`);
  }
  function deleteClips(ids) {
    const a = getProject().arrangement, removed = a.clips.filter(clip => ids.has(clip.id));
    if (!removed.length) return;
    edit(() => { a.clips = a.clips.filter(clip => !ids.has(clip.id)); selectedClipId = null; selectedIds.clear(); });
    offerUndo(`Deleted ${removed.length} clip${removed.length > 1 ? "s" : ""}`);
  }
  // Razor: cut every clip that spans `time` (only the selected ones if any are selected there).
  function cutAt(time, onlySelected = false) {
    const a = getProject().arrangement, at = item => item.start + item.offsetMs / 1000;
    let hits = a.clips.filter(clip => time > at(clip) + .001 && time < at(clip) + clip.length - .001);
    if (onlySelected && hits.some(clip => selectedIds.has(clip.id))) hits = hits.filter(clip => selectedIds.has(clip.id));
    if (!hits.length) { report(`Nothing to cut at ${time.toFixed(3)} s`); return; }
    edit(() => {
      const parts = [];
      for (const clip of hits) {
        const pieces = sliceClip({ ...clip, start: at(clip), offsetMs: 0 }, time).map(piece => ({ ...piece, start: piece.start - clip.offsetMs / 1000, offsetMs: clip.offsetMs }));
        pieces[0].id = clip.id; a.clips.splice(a.clips.indexOf(clip), 1, ...pieces); parts.push(pieces[1].id);
      }
      selectedIds = new Set(parts); selectedClipId = parts[0];
    });
    report(`Cut ${hits.length} clip${hits.length > 1 ? "s" : ""} at ${time.toFixed(3)} s`);
  }
  $("cutCursor").onclick = () => cutAt(cursor, true);

  function animateLanding(id) {
    if (document.documentElement.dataset.motion !== "on" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelector(`[data-clip-id="${CSS.escape(id)}"]`)?.animate(
      [{transform:"translateY(-2px)"}, {transform:"translateY(0)"}], {duration:80, easing:"steps(2)"});
  }
  function addClip(patternId, lane = 0, start = 0) {
    edit(project => {
      const pattern = project.patterns.find(item => item.id === patternId);
      if (!pattern || project.arrangement.clips.length >= 1024) return;
      const position = clamp(start, 0, MAX_SONG - pattern.lengthSec);
      const clip = { id: newId(), kind: "pattern", ref: patternId, lane, start: position,
        length: pattern.lengthSec, loopLength: pattern.lengthSec,
        trimStart: 0, fadeIn: 0, fadeOut: 0, offsetMs: 0 };
      project.arrangement.clips.push(clip); selectedClipId = clip.id; selectedIds = new Set([clip.id]);
    });
  }
  $("patternPicker").onchange = event => onPatternSelect(event.target.value);
  $("newPattern").onclick = () => edit(project => {
    if (project.patterns.length >= 128) return;
    const pattern = createPattern("Pattern " + String(project.patterns.length + 1).padStart(2, "0"), 4 * 60 / project.bpm);
    project.patterns.push(pattern); project.activePatternId = pattern.id;
  });
  $("duplicatePattern").onclick = () => edit(project => {
    if (project.patterns.length >= 128) return;
    const copy = duplicatePattern(project.patterns.find(pattern => pattern.id === project.activePatternId));
    project.patterns.push(copy); project.activePatternId = copy.id;
  });
  $("patternName").onchange = event => {
    const name = event.target.value.trim();
    if (name) edit(project => { project.patterns.find(pattern => pattern.id === project.activePatternId).name = name.slice(0, 160); });
    else render();
  };
  $("deletePattern").onclick = () => { deletePattern(getProject().activePatternId); };
  $("projectName").onchange = event => {
    const name = event.target.value.trim();
    if (name) edit(project => { project.name = name.slice(0, 160); }); else render();
  };
  $("saveProject").onclick = onSave;
  $("loadProject").onclick = () => $("projectFile").click();
  $("projectFile").onchange = async event => {
    const file = event.target.files[0];
    if (file) await onLoad(file);
    event.target.value = "";
  };
  $("addClip").onclick = () => {
    const project = getProject(), clips = project.arrangement.clips;
    const lane = selected()?.lane ?? selectedLane ?? 0; // the selected lane, not always Lane 1 (BUGS.md E2)
    const end = Math.max(0, ...clips.filter(clip => clip.lane === lane).map(clip => clip.start + clip.offsetMs / 1000 + clip.length));
    addClip(project.activePatternId, lane, end); // after the lane's last clip; the song grows if needed
  };
  $("songLength").onchange = event => {
    const length = clamp(+event.target.value || 64, .01, 3600);
    edit(project => {
      const a = project.arrangement; a.lengthSec = length;
      a.clips = a.clips.filter(clip => clip.start < length);
      a.clips.forEach(clip => { clip.length = Math.min(clip.length, length - clip.start); });
      a.loop.start = Math.min(a.loop.start, length - .001);
      a.loop.end = clamp(a.loop.end, a.loop.start + .001, length);
    });
  };
  $("addLane").onclick = () => edit(project => { if (project.arrangement.lanes.length < 16) project.arrangement.lanes.push(createLane(project.arrangement.lanes.length)); });
  $("songLoop").onchange = event => edit(project => { project.arrangement.loop.on = event.target.checked; });
  $("loopFrom").onchange = event => {
    const value = +event.target.value;
    edit(project => { project.arrangement.loop.start = clamp(Number.isFinite(value) ? value : 0, 0, project.arrangement.loop.end - .001); });
  };
  $("loopTo").onchange = event => {
    const value = +event.target.value;
    edit(project => { project.arrangement.loop.end = clamp(Number.isFinite(value) ? value : 8, project.arrangement.loop.start + .001, project.arrangement.lengthSec); });
  };
  const updateClip = mutation => { if (selected()) edit(() => mutation(selected(), getProject().arrangement)); };
  $("clipStart").onchange = event => updateClip((clip, a) => { clip.start = clamp(snap(+event.target.value || 0), 0, MAX_SONG - clip.length); });
  $("clipLength").onchange = event => updateClip((clip, a) => { clip.length = clamp(snap(+event.target.value || .001), .001, MAX_SONG - clip.start); clip.loopLength = Math.max(clip.loopLength, clip.trimStart + clip.length); });
  $("clipLane").onchange = event => updateClip((clip, a) => { clip.lane = clamp(Math.round(+event.target.value || 1) - 1, 0, a.lanes.length - 1); });
  $("clipLoopLength").onchange = event => updateClip(clip => { clip.loopLength = clamp(+event.target.value || .01, .01, 3600); });
  $("clipTrim").onchange = event => updateClip(clip => { clip.trimStart = clamp(+event.target.value || 0, 0, 86400); });
  $("clipOffset").onchange = event => updateClip(clip => { clip.offsetMs = clamp(+event.target.value || 0, -1000, 1000); });
  $("clipFadeIn").onchange = event => updateClip(clip => { clip.fadeIn = clamp(+event.target.value || 0, 0, clip.length - clip.fadeOut); });
  $("clipFadeOut").onchange = event => updateClip(clip => { clip.fadeOut = clamp(+event.target.value || 0, 0, clip.length - clip.fadeIn); });
  $("duplicateClip").onclick = () => updateClip((clip, a) => {
    if (a.clips.length >= 1024) return;
    const copy = { ...clip, id: newId(), start: Math.min(clip.start + clip.length, MAX_SONG - clip.length) };
    a.clips.push(copy); selectedClipId = copy.id; selectedIds = new Set([copy.id]);
  });
  const deleteSelected = () => { if (selected()) deleteClips(new Set(selectedIds.size ? selectedIds : [selectedClipId])); };
  $("deleteClip").onclick = deleteSelected;
  $("editClipPattern").onclick = () => { if (selected()) onOpenPattern(selected().ref); };
  function split(clip, time) {
    try { const parts = sliceClip(clip, time); edit(project => {
      project.arrangement.clips.splice(project.arrangement.clips.indexOf(clip), 1, ...parts);
      selectedIds = new Set(parts.map(part => part.id)); selectedClipId = parts[1].id;
    }); } catch (error) { report(error.message); }
  }
  $("sliceClip").onclick = () => { if (selected()) split(selected(), selected().start + selected().length / 2); };
  $("glueClips").onclick = () => {
    const a = getProject().arrangement, clips = a.clips.filter(clip => selectedIds.has(clip.id));
    try { const joined = glueClips(clips, a.lanes[clips[0]?.lane]); edit(() => {
      a.clips = a.clips.filter(clip => !selectedIds.has(clip.id)); a.clips.push(joined);
      selectedIds = new Set([joined.id]); selectedClipId = joined.id;
    }); } catch (error) { report(error.message); }
  };
  for (const name of ["select", "draw", "slice"]) $("tool" + name).onclick = () => { tool = name; render(); };
  function zoom(factor) { pps = clamp(pps * factor, 20, 320); render(); }
  $("zoomIn").onclick = () => zoom(1.25); $("zoomOut").onclick = () => zoom(.8);
  $("timelineScroll").addEventListener("wheel", event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        !event.target.closest("input, select, textarea, [contenteditable=true], #pianoRoll") &&
        ["overview","timeline"].includes(document.body.dataset.view)) {
      const key = event.key.toLowerCase(), clip = selected(), project = getProject();
      if (key === "c" && clip) clipboard = { ...clip };
      else if (key === "d" && clip && clip.start + 2 * clip.length <= MAX_SONG) $("duplicateClip").click();
      else if (key === "v" && clipboard && project.patterns.some(p => p.id === clipboard.ref) &&
               project.arrangement.clips.length < 1024 && cursor + clipboard.length <= MAX_SONG) {
        const copy = { ...clipboard, id: newId(), lane: clip?.lane ?? selectedLane ?? 0, start: cursor };
        edit(p => { p.arrangement.clips.push(copy); selectedClipId = copy.id; selectedIds = new Set([copy.id]); });
      } else return;
      event.preventDefault(); return;
    }
    if (event.target.closest("input, select, textarea, [contenteditable=true]") || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (["v", "b", "c", "g", "l", "k"].includes(key) && event.target.closest(".arrangement")) {
      event.preventDefault();
      if (key === "g") $("glueClips").click(); else if (key === "l") $("songLoop").click(); else if (key === "k") cutAt(cursor, true);
      else { tool = ({ v: "select", b: "draw", c: "slice" })[key]; render(); }
    }
  });

  function drawFades(button, clip) {
    const f = clipFades(clip, getProject().arrangement.clips);
    button.querySelector(".fade-in-shape").style.width = f.fadeIn * pps + "px";
    button.querySelector(".fade-out-shape").style.width = f.fadeOut * pps + "px";
    button.querySelector(".fade-in-grip").style.left = f.fadeIn * pps + "px";
    button.querySelector(".fade-out-grip").style.right = f.fadeOut * pps + "px";
  }
  const peakCache = new WeakMap();
  function peaksOf(buffer, n = 2000) {
    if (peakCache.has(buffer)) return peakCache.get(buffer);
    const data = buffer.getChannelData(0), step = Math.max(1, Math.floor(data.length / n)), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let max = 0; for (let j = i * step, e = Math.min(data.length, j + step); j < e; j += 8) max = Math.max(max, Math.abs(data[j])); out[i] = max; }
    const top = Math.max(...out) || 1; for (let i = 0; i < n; i++) out[i] /= top;
    peakCache.set(buffer, out); return out;
  }
  function clipPreview(button, pattern, clip, laneData) {
    const period = laneData.loopLength || clip.loopLength, origin = clip.start - clip.trimStart;
    const reps = Math.ceil((clip.length + clip.trimStart) / period - 1e-6);
    const head = document.createElement("span"); head.className = "clip-head"; head.textContent = pattern.name + (reps > 1 ? ` · ×${reps}` : "");
    const body = document.createElement("span"); body.className = "clip-body"; button.append(head, body);
    const cycleOf = t => Math.floor((t - origin) / period + 1e-9);
    const audio = pattern.layers.find(layer => layer.kind === "audio" && layer.buffer);
    if (audio) {
      const width = Math.max(1, Math.min(4096, Math.round(clip.length * pps))), height = 40, canvas = document.createElement("canvas");
      canvas.className = "clip-wave"; canvas.width = width; canvas.height = height;
      const g = canvas.getContext("2d"), peaks = peaksOf(audio.buffer), duration = audio.audio.duration, scale = clip.length / width;
      for (let x = 0; x < width; x++) {
        const t = clip.start + x * scale, local = ((t - origin) % period + period) % period;
        if (local >= duration) continue;
        const v = peaks[Math.min(peaks.length - 1, Math.floor(local / duration * peaks.length))], h = Math.max(1, v * (height - 2));
        g.fillStyle = cycleOf(t) > 0 ? "#FFFFFF66" : "#FFFFFFE6"; g.fillRect(x, (height - h) / 2, 1, h);
      }
      body.appendChild(canvas);
    } else {
      const events = clipEvents(pattern, { ...clip, offsetMs: 0 }, 90, -Infinity, Infinity, { loopLength: laneData.loopLength });
      const pitched = pattern.layers.flatMap(layer => layer.events || []).filter(event => event.type === "on").map(event => event.m);
      const lo = Math.min(...pitched, 60), hi = Math.max(...pitched, lo + 1), open = new Map(); let count = 0;
      const add = (t, d, top, ghost) => {
        if (count++ > 600) return;
        const note = document.createElement("i"); note.className = "nt" + (ghost ? " g" : "");
        note.style.left = (t - clip.start) * pps + "px"; note.style.width = Math.max(2, d * pps - 1) + "px"; note.style.top = top + "%"; body.appendChild(note);
      };
      for (const event of events) {
        const key = event.layerIndex + ":" + event.m;
        if (event.type === "hit") add(event.t, event.d || .04, 8 + (event.i % 6) * 15, cycleOf(event.t) > 0);
        else if (event.type === "on") open.set(key, event);
        else if (open.has(key)) { const on = open.get(key); open.delete(key); add(on.t, event.t - on.t, 6 + (1 - (on.m - lo) / (hi - lo)) * 80, cycleOf(on.originT) > 0); }
      }
    }
    for (let k = 1; origin + k * period < clip.start + clip.length - 1e-6 && k < 256; k++) {
      const x = origin + k * period - clip.start; if (x <= 0) continue;
      const notch = document.createElement("span"); notch.className = "clip-notch"; notch.style.left = x * pps + "px"; button.appendChild(notch);
    }
  }
  function bindClip(button, clip) {
    button.onclick = event => { if (!event.detail) onOpenPattern(clip.ref, clip.lane); };
    button.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Backspace"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); selectedClipId = clip.id; selectedIds = new Set([clip.id]);
      if (event.key === "Delete" || event.key === "Backspace") { deleteSelected(); return; }
      edit(project => {
        if (event.key === "ArrowLeft") clip.start = Math.max(0, clip.start - step());
        if (event.key === "ArrowRight") clip.start = Math.min(MAX_SONG - clip.length, clip.start + step());
        if (event.key === "ArrowUp") clip.lane = Math.max(0, clip.lane - 1);
        if (event.key === "ArrowDown") clip.lane = Math.min(project.arrangement.lanes.length - 1, clip.lane + 1);
      });
      $("timeline").querySelector(`[data-clip-id="${CSS.escape(clip.id)}"]`)?.focus();
    };
    button.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      button.focus({ preventScroll: true });
      if (tool === "slice") { const t = snap(timeAt(event), event); if (event.shiftKey) cutAt(t); else split(clip, t); return; }
      selectClip(clip, event);
      if (event.shiftKey) { render(); return; }
      const resize = event.target.classList.contains("resize-grip"), loop = event.target.classList.contains("loop-grip"), trim = event.target.classList.contains("trim-grip");
      const fadeIn = event.target.classList.contains("fade-in-grip"), fadeOut = event.target.classList.contains("fade-out-grip");
      const startTime = timeAt(event), startY = event.clientY, original = { ...clip };
      let moved = false, next = { ...clip };
      let pointer, edgeFrame = 0;
      function panAtEdge() {
        edgeFrame = 0;
        if (!pointer || !moved) return;
        const bounds = scroll.getBoundingClientRect();
        const dx = pointer.clientX > bounds.right - 32 ? 12 : pointer.clientX < bounds.left + 32 ? -12 : 0;
        if (!dx) return;
        if (dx > 0 && scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 32) {
          dragEnd = Math.min(MAX_SONG, canvasEnd(getProject().arrangement) + HEADROOM);
          $("timeline").style.width = (dragEnd * pps + HEAD_WIDTH) + "px";
        }
        const before = scroll.scrollLeft;
        scroll.scrollLeft += dx;
        if (scroll.scrollLeft !== before) moveHandler(pointer);
      }
      const moveHandler = move => {
        pointer = move;
        const dx = timeAt(move) - startTime;
        if (Math.abs(dx * pps) + Math.abs(move.clientY - startY) < 3) return;
        moved = true;
        if (!edgeFrame) edgeFrame = requestAnimationFrame(panAtEdge);
        const a = getProject().arrangement;
        if (fadeIn || fadeOut) {
          // fades are free (never snapped): they are about feel, not the grid
          if (fadeIn) next.fadeIn = clamp(original.fadeIn + dx, 0, original.length - original.fadeOut);
          else next.fadeOut = clamp(original.fadeOut - dx, 0, original.length - original.fadeIn);
          drawFades(button, next);
          return;
        } else if (resize || loop) {
          next.length = clamp(snap(original.length + dx, move), .001, canvasEnd(a) - original.start);
          if (resize) next.loopLength = Math.max(original.loopLength, original.trimStart + next.length);
        } else if (trim) {
          next.start = clamp(snap(original.start + dx, move), Math.max(0, original.start - original.trimStart), original.start + original.length - .001);
          next.length = original.start + original.length - next.start; next.trimStart = original.trimStart + next.start - original.start;
        }
        else {
          next.start = clamp(snap(original.start + dx, move), 0, Math.max(0, canvasEnd(a) - original.length));
          next.lane = clamp(original.lane + Math.round((move.clientY - startY) / LANE_HEIGHT), 0, a.lanes.length - 1);
        }
        button.style.left = next.start * pps + "px";
        button.style.width = next.length * pps + "px";
        button.style.transform = `translateY(${(next.lane - original.lane) * LANE_HEIGHT}px)`;
      };
      const finish = cancelled => {
        cancelAnimationFrame(edgeFrame); dragEnd = 0;
        window.removeEventListener("pointermove", moveHandler); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel);
        if (moved && !cancelled) edit(project => {
          if ((event.ctrlKey || event.metaKey) && !resize && !loop && !trim && !fadeIn && !fadeOut) {
            next.id = newId(); project.arrangement.clips.push(next); selectedIds = new Set([next.id]); selectedClipId = next.id;
          } else Object.assign(clip, next);
        });
        if (moved && !cancelled) animateLanding(selectedClipId);
        else {
          const now = performance.now(), doubleTap = !cancelled && lastClipTap?.id === clip.id && now - lastClipTap.time < 350;
          lastClipTap = { id: clip.id, time: now }; render();
          selectedLane = clip.lane;
          if (doubleTap) { lastClipTap = null; onOpenPattern(clip.ref, clip.lane); }
          else if (!cancelled) onPatternSelect(clip.ref, clip.lane);
        }
      };
      const up = () => finish(false), cancel = () => finish(true);
      window.addEventListener("pointermove", moveHandler); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel);
    };
  }

  function rulerDrag(event) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    $("timelineScroll").focus({ preventScroll: true });
    const a = getProject().arrangement, original = { ...a.loop }, t0 = timeAt(event), part = event.target.dataset.loopPart;
    let next = { ...original }, moved = false;
    const move = ev => {
      if (!moved && !part && Math.abs(timeAt(ev) - t0) * pps < 4) return;
      moved = true; const t = clamp(snap(timeAt(ev), ev), 0, a.lengthSec);
      if (part === "left") next.start = clamp(snap(original.start + timeAt(ev) - t0, ev), 0, original.end - .001);
      else if (part === "right") next.end = clamp(snap(original.end + timeAt(ev) - t0, ev), original.start + .001, a.lengthSec);
      else if (part === "body") { next.start = clamp(original.start + snap(t - t0, ev), 0, a.lengthSec - (original.end - original.start)); next.end = next.start + original.end - original.start; }
      else { next.start = Math.min(snap(t0, ev), t); next.end = Math.max(snap(t0, ev), t); }
      next.on = true;
      const region = $("timeline").querySelector(".loop-region");
      if (region) { region.style.left = HEAD_WIDTH + next.start * pps + "px"; region.style.width = (next.end - next.start) * pps + "px"; }
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel);
      if (moved && next.end - next.start >= .001) edit(() => { a.loop = next; });
      else if (!moved && !part) { cursor = clamp(snap(t0, event), 0, a.lengthSec); setPlayhead(null); onJump(cursor); }
    };
    const cancel = () => { moved = false; up(); render(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel);
  }

  function render() {
    const restoreClipFocus = document.activeElement?.closest?.(".timeline-clip");
    const project = getProject(), a = project.arrangement;
    const active = project.patterns.find(pattern => pattern.id === project.activePatternId);
    $("projectName").value = project.name;
    $("patternName").value = active.name;
    $("patternLength").value = active.lengthSec;
    $("patternPicker").replaceChildren(...project.patterns.map(pattern => {
      const option = document.createElement("option"); option.value = pattern.id; option.textContent = pattern.name; return option;
    }));
    $("patternPicker").value = active.id;
    $("deletePattern").disabled = false;
    $("patternBank").replaceChildren(...project.patterns.map(pattern => {
      const button = document.createElement("button"); button.className = "pattern-chip"; button.draggable = true;
      button.textContent = `${pattern.name} · ${pattern.lengthSec.toFixed(3)} s · ${pattern.source ? "TUNE" : pattern.layers.some(layer => layer.kind === "audio") ? "AUDIO" : pattern.layers.length + " LAYERS"}`;
      button.setAttribute("aria-pressed", String(pattern.id === active.id)); button.dataset.ref = pattern.id;
      button.onclick = () => {
        selectedLane = null;
        selectedClipId=null;selectedIds.clear();
        const now = performance.now(), doubleTap = lastPatternTap?.id === pattern.id && now - lastPatternTap.time < 350;
        lastPatternTap = { id: pattern.id, time: now };
        if (doubleTap) { lastPatternTap = null; onOpenPattern(pattern.id); } else onPatternSelect(pattern.id);
      };
      button.ondragstart = event => { event.dataTransfer.setData("application/x-muse-pattern", pattern.id); event.dataTransfer.effectAllowed = "copy"; };
      button.onkeydown = event => { if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deletePattern(pattern.id); } };
      button.title = "Click to select · double-click to open · drag onto a lane · Delete to remove";
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "chip-del"; remove.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-x"/></svg>';
      remove.title = `Delete ${pattern.name}`; remove.setAttribute("aria-label", `Delete ${pattern.name}`);
      remove.onclick = event => { event.stopPropagation(); deletePattern(pattern.id); };
      const item = document.createElement("span"); item.className = "pattern-item" + (pattern.id === active.id ? " active" : ""); item.append(button, remove);
      return item;
    }));
    $("songLength").value = a.lengthSec; $("songLoop").checked = a.loop.on;
    $("loopFrom").value = a.loop.start; $("loopTo").value = a.loop.end;
    $("loopFrom").max = a.loop.end - .001; $("loopTo").max = a.lengthSec;
    $("addLane").disabled = a.lanes.length >= 16;
    for (const name of ["select", "draw", "slice"]) $("tool" + name).setAttribute("aria-pressed", String(name === tool));
    const timeline = $("timeline"); timeline.replaceChildren();
    timeline.style.width = canvasEnd(a) * pps + HEAD_WIDTH + "px";
    timeline.style.height = RULER_HEIGHT + a.lanes.length * LANE_HEIGHT + "px";
    timeline.style.setProperty("--pps", pps + "px");
    const tickStep = pps >= 256 ? .25 : pps >= 128 ? .5 : Math.max(1, Math.ceil(64 / pps));
    timeline.style.setProperty("--grid-major", pps * tickStep + "px");
    timeline.style.setProperty("--grid-minor", pps * tickStep / 2 + "px");
    const head = document.createElement("div"); head.className = "ruler-head"; head.textContent = "FREE TIME · S / MS"; timeline.appendChild(head);
    const loopTrack = document.createElement("div"); loopTrack.className = "loop-track"; loopTrack.onpointerdown = rulerDrag; timeline.appendChild(loopTrack);
    const ruler = document.createElement("div"); ruler.className = "bar-ruler";
    ruler.onpointerdown = rulerDrag;
    for (let sec = 0; sec < canvasEnd(a); sec += tickStep) {
      const label = document.createElement("span"); label.textContent = +sec.toFixed(3) + "s"; label.style.flexBasis = pps * tickStep + "px"; ruler.appendChild(label);
    }
    timeline.appendChild(ruler);
    {
      const region = document.createElement("div"); region.className = "loop-region";
      region.classList.toggle("off", !a.loop.on); region.dataset.loopPart = "body";
      region.style.left = HEAD_WIDTH + a.loop.start * pps + "px"; region.style.width = (a.loop.end - a.loop.start) * pps + "px";
      region.setAttribute("aria-label", `Loop ${a.loop.start.toFixed(3)} to ${a.loop.end.toFixed(3)} seconds`); region.onpointerdown = rulerDrag;
      for (const side of ["left", "right"]) { const handle = document.createElement("span"); handle.className = "loop-edge " + side; handle.dataset.loopPart = side; region.appendChild(handle); }
      timeline.appendChild(region);
    }
    for (let laneIndex = 0; laneIndex < a.lanes.length; laneIndex++) {
      const laneData = a.lanes[laneIndex];
      const label = document.createElement("div"); label.className = "lane-label mono";
      label.onclick = event => { if (!event.target.closest("input,button")) chooseLane(laneIndex); };
      const name = document.createElement("input"); name.className = "lane-name"; name.type = "text"; name.maxLength = 160; name.value = laneData.name;
      name.setAttribute("aria-label", `Lane ${laneIndex + 1} name`);
      name.onchange = () => { const value = name.value.trim(); if (value) edit(() => { laneData.name = value; }); else render(); }; label.appendChild(name);
      const settings = document.createElement("div"); settings.className = "lane-settings";
      for (const action of ["mute", "solo"]) {
        const button = document.createElement("button"); button.className = "lane-toggle"; button.dataset.action = action; button.textContent = action === "mute" ? "M" : "S";
        button.setAttribute("aria-label", `${action === "mute" ? "Mute" : "Solo"} ${laneData.name}`); button.setAttribute("aria-pressed", String(laneData[action]));
        button.onclick = () => edit(() => { laneData[action] = !laneData[action]; }); settings.appendChild(button);
      }
      const length = document.createElement("input"); length.type = "number"; length.min = ".01"; length.step = ".01"; length.placeholder = "LANE LOOP S"; length.title = "Lane loop in seconds overrides the repeat length of every clip on this lane"; length.value = laneData.loopLength ?? "";
      length.className = "lane-loop";
      length.setAttribute("aria-label", `${laneData.name} loop seconds`);
      length.onchange = () => edit(() => { laneData.loopLength = length.value === "" ? null : clamp(+length.value || .01, .01, 3600); }); settings.appendChild(length); label.appendChild(settings);
      label.style.top = RULER_HEIGHT + laneIndex * LANE_HEIGHT + "px";
      const laneColor = LANE_COLORS[laneIndex % LANE_COLORS.length];
      label.style.setProperty("--lane", laneColor);
      timeline.appendChild(label);
      const lane = document.createElement("div"); lane.className = "timeline-lane" + (selectedLane === laneIndex ? " record-target" : ""); lane.dataset.lane = laneIndex;
      lane.style.setProperty("--lane", laneColor);
      lane.style.top = RULER_HEIGHT + laneIndex * LANE_HEIGHT + "px";
      lane.onpointerdown = event => { if (event.target === lane && tool === "draw") {
        $("timelineScroll").focus({ preventScroll: true }); addClip(project.activePatternId, laneIndex, snap(timeAt(event), event));
      } else if (event.target === lane && tool === "slice" && event.shiftKey) cutAt(snap(timeAt(event), event));
      else if (event.target === lane && tool === "select") chooseLane(laneIndex, event); };
      lane.ondragover = event => {
        const types = Array.from(event.dataTransfer.types);
        if (types.includes("application/x-muse-pattern") || types.includes("application/x-muse-take") || types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; lane.classList.add("drop-target"); }
      };
      lane.ondragleave = () => lane.classList.remove("drop-target");
      lane.ondrop = event => {
        event.preventDefault(); lane.classList.remove("drop-target");
        const files = [...(event.dataTransfer.files || [])];
        // audio files dropped from the desktop land exactly where they are dropped (Alt bypasses snap)
        if (files.length) { onDropFiles(files, laneIndex, snap(timeAt(event), event)); return; }
        if (Array.from(event.dataTransfer.types).includes("application/x-muse-take")) { onDropTake(laneIndex, snap(timeAt(event), event)); return; }
        const id = event.dataTransfer.getData("application/x-muse-pattern");
        if (id) { addClip(id, laneIndex, snap(timeAt(event), event)); if (selectedClipId) animateLanding(selectedClipId); }
      };
      for (const clip of a.clips.filter(item => item.lane === laneIndex)) {
        const pattern = project.patterns.find(item => item.id === clip.ref);
        const button = document.createElement("button"); button.className = "timeline-clip" + (selectedIds.has(clip.id) ? " selected" : "");
        button.dataset.clipId = clip.id;
        button.title = `${pattern.name} · ${clip.start.toFixed(3)} s · ${clip.length.toFixed(3)} s · ${clip.offsetMs} ms`;
        button.setAttribute("aria-label", button.title);
        button.style.left = clip.start * pps + "px"; button.style.width = clip.length * pps + "px";
        clipPreview(button, pattern, clip, laneData);
        for (const kind of ["loop-grip", "trim-grip"]) { const handle = document.createElement("span"); handle.className = kind; handle.setAttribute("aria-hidden", "true"); button.appendChild(handle); }
        button.querySelector(".loop-grip").innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-loop"/></svg> LOOP'; button.querySelector(".loop-grip").title = "Drag to repeat (loop) this clip";
        if (selectedIds.has(clip.id)) {
          const remove = document.createElement("span"); remove.className = "clip-del"; remove.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-x"/></svg>'; remove.title = "Delete clip (Del)";
          remove.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); deleteClips(new Set([clip.id])); };
          button.appendChild(remove);
        }
        const grip = document.createElement("span"); grip.className = "resize-grip"; grip.setAttribute("aria-hidden", "true"); button.appendChild(grip);
        for (const kind of ["fade-in-shape", "fade-out-shape", "fade-in-grip", "fade-out-grip"]) {
          const part = document.createElement("span"); part.className = kind; part.setAttribute("aria-hidden", "true");
          if (kind.endsWith("grip")) part.title = kind === "fade-in-grip" ? "Drag to fade in" : "Drag to fade out";
          button.appendChild(part);
        }
        drawFades(button, clip);
        bindClip(button, clip); lane.appendChild(button);
      }
      timeline.appendChild(lane);
    }
    { // song end: grid past it is room to drag into; the song grows when a clip lands there
      const end = document.createElement("div"); end.className = "song-end"; end.setAttribute("aria-hidden", "true");
      end.style.left = HEAD_WIDTH + a.lengthSec * pps + "px"; end.style.top = RULER_HEIGHT + "px"; end.title = `Song ends at ${a.lengthSec} s`;
      timeline.appendChild(end);
    }
    const playhead = document.createElement("div"); playhead.id = "songPlayhead"; playhead.className = "song-playhead";
    playhead.setAttribute("aria-hidden", "true"); playhead.style.left = HEAD_WIDTH + cursor * pps + "px";
    const grab = document.createElement("span"); grab.className = "playhead-grab"; grab.title = "Drag the cursor (click the time strip to jump)";
    grab.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const move = ev => { cursor = clamp(snap(timeAt(ev), ev), 0, a.lengthSec); setPlayhead(null); };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onJump(cursor); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    };
    playhead.appendChild(grab); timeline.appendChild(playhead);
    const guide = document.createElement("div"); guide.className = "slice-guide"; guide.hidden = true; guide.setAttribute("aria-hidden", "true");
    guide.style.top = RULER_HEIGHT + "px"; guide.appendChild(document.createElement("span")); timeline.appendChild(guide);
    timeline.classList.toggle("tool-slice", tool === "slice");
    timeline.onpointermove = event => {
      if (tool !== "slice" || event.clientX - timeline.getBoundingClientRect().left < HEAD_WIDTH) { guide.hidden = true; return; }
      const t = clamp(snap(timeAt(event), event), 0, a.lengthSec);
      guide.hidden = false; guide.style.left = HEAD_WIDTH + t * pps + "px"; guide.firstChild.textContent = t.toFixed(3) + " s";
    };
    timeline.onpointerleave = () => { guide.hidden = true; };
    const clip = selected(); $("clipInspector").hidden = !clip;
    if (clip) {
      $("clipStart").value = clip.start; $("clipLength").value = clip.length;
      $("clipLane").value = clip.lane + 1; $("clipLane").max = a.lanes.length;
      $("clipOffset").value = clip.offsetMs;
      $("clipLoopLength").value = clip.loopLength; $("clipTrim").value = clip.trimStart;
      $("clipFadeIn").value = +clip.fadeIn.toFixed(3); $("clipFadeOut").value = +clip.fadeOut.toFixed(3);
      $("audioClipTools").hidden = !project.patterns.find(item => item.id === clip.ref)?.layers.some(layer => layer.kind === "audio");
    }
    $("arrangementEmpty").hidden = a.clips.length > 0;
    onSelection();
    if (restoreClipFocus) (timeline.querySelector(`[data-clip-id="${CSS.escape(selectedClipId || "")}"]`) || $("timelineScroll")).focus({ preventScroll: true });
  }
  // null = stopped: the playhead rests on the cursor (where PLAY starts and K cuts).
  function setPlayhead(time) {
    const shown = time ?? cursor;
    $("songClock").textContent = shown.toFixed(3) + " s";
    const element = $("songPlayhead"); if (!element) return;
    element.classList.toggle("playing", time !== null);
    const x = HEAD_WIDTH + shown * pps;
    element.style.left = x + "px";
    if (time === null) suspended = false;
    else if (following && !suspended && scroll.clientWidth && (x > scroll.scrollLeft + .85 * scroll.clientWidth || x < scroll.scrollLeft + HEAD_WIDTH)) {
      scroll.scrollLeft = Math.max(0, x - HEAD_WIDTH - 10);
      autoScrollLeft = scroll.scrollLeft;
    }
  }
  function setCursor(time) { cursor = Math.max(0, time || 0); setPlayhead(null); }
  render();
  return { render, setPlayhead, setCursor, getCursor: () => cursor, getSelection:()=>({lane:selected()?.lane??selectedLane??0,clip:selected()}) };
}

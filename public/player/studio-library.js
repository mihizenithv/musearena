const $ = id => document.getElementById(id);
const prefix = "musearena.project.";
let projectId;
export function rememberProject(data) {
  projectId ||= localStorage.getItem("musearena.current") || crypto.randomUUID();
  localStorage.setItem(prefix + projectId, JSON.stringify(data));
  localStorage.setItem("musearena.current", projectId);
}
export function mountLibrary({ snapshot, create, load, enter, pause }) {
  const dialog = $("studioLibrary"), list = $("savedStudios"), message = $("libraryStatus");
  projectId = localStorage.getItem("musearena.current");
  function open() {
    pause(); list.replaceChildren(); message.textContent = "";
    for (const key of Object.keys(localStorage).filter(key => key.startsWith(prefix))) {
      try {
        const data = JSON.parse(localStorage.getItem(key));
        const choice = document.createElement("button");
        choice.type = "button"; choice.className = "btn"; choice.textContent = data.name;
        choice.onclick = () => switchProject(data, key.slice(prefix.length));
        list.append(choice);
      } catch { /* Ignore an unreadable entry; keep its stored data. */ }
    }
    const intro = $("intro");
    if (!intro.hidden) {
      const watcher = new MutationObserver(() => {
        if (intro.hidden) { watcher.disconnect(); dialog.showModal(); }
      });
      watcher.observe(intro, {attributes:true, attributeFilter:["hidden"]});
    } else dialog.showModal();
  }
  let busy = false;
  async function switchProject(data, id) {
    if (busy) return;
    busy = true;
    try {
      const current = snapshot();
      if (projectId || current.name !== "Untitled" || current.patterns.some(p=>p.layers.length) || current.arrangement.clips.length) rememberProject(current);
      if (!await load(JSON.stringify(data))) throw Error($("status").textContent);
      projectId = id;
      rememberProject(snapshot());
      dialog.close(); enter();
    } catch (error) { message.textContent = error.message; }
    finally { busy = false; }
  }
  $("newStudioProject").onclick = () => {
    const data = create(); data.name = $("studioName").value.trim() || "Untitled";
    switchProject(data, crypto.randomUUID());
  };
  $("resumeStudio").onclick = () => { dialog.close(); enter(); };
  $("libraryImport").onchange = async event => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file) return;
    try {
      if(file.size > 5*1024*1024) throw Error("Projects must be under 5 MB.");
      await switchProject(JSON.parse(await file.text()), crypto.randomUUID());
    } catch(error) { message.textContent = error.message; }
  };
  $("projectLibraryBtn").onclick = open;
  dialog.addEventListener("cancel", event => { event.preventDefault(); $("resumeStudio").click(); });
  dialog.addEventListener("keydown", event => event.stopPropagation());
  if (!location.hash && !sessionStorage.getItem("musearena.studioEntered")) open();
}

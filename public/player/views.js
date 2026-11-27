// Interface tabs: OVERVIEW (the original all-in-one page, unchanged) plus full-screen TIMELINE, BEAT MAKER and AI views.
// All views share one project and one audio engine; switching only rearranges the page (CSS on body[data-view]),
// so nothing reloads and playback continues.
const VIEWS = ["overview", "timeline", "beat"];
const $ = id => document.getElementById(id);

export function mountViews({ onChange = () => {} } = {}) {
  const tabs = [...document.querySelectorAll("[data-view-tab]")];
  function set(view, { focus = false, push = true } = {}) {
    if (!VIEWS.includes(view)) view = "overview";
    document.body.dataset.view = view;
    for (const tab of tabs) {
      const on = tab.dataset.viewTab === view;
      tab.setAttribute("aria-selected", String(on)); tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    if (push && location.hash !== "#" + view) history.replaceState(null, "", view === "overview" ? location.pathname + location.search : "#" + view);
    const panel = document.getElementById("playlistPanel"); if (panel) panel.scrollTop = 0;
    onChange(view);
    window.dispatchEvent(new Event("resize")); // canvases and the dock re-measure for the new layout
  }
  for (const tab of tabs) {
    tab.onclick = () => set(tab.dataset.viewTab);
    tab.onkeydown = event => { // arrow keys move between tabs (WAI-ARIA tabs pattern)
      const i = tabs.indexOf(tab), step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (step) { event.preventDefault(); set(tabs[(i + step + tabs.length) % tabs.length].dataset.viewTab, { focus: true }); }
    };
  }
  // Alt+1..4 switches views from anywhere
  window.addEventListener("keydown", event => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const n = +event.key; if (n >= 1 && n <= VIEWS.length) { event.preventDefault(); set(VIEWS[n - 1]); }
  });
  window.addEventListener("hashchange", () => set(location.hash.slice(1), { push: false }));
  set(location.hash.slice(1), { push: false }); // a link like #timeline opens that view; otherwise Overview
  return { set, get: () => document.body.dataset.view };
}

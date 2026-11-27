const $ = id => document.getElementById(id);

export function mountDock({ onResize, onCollapse = () => {} }) {
  const stage = document.querySelector('.stage'), dock = $('patternEditor'), splitter = $('playerSplitter'), toggle = $('closeEditor');
  let height = 420;
  try { height = Math.max(300, Math.min(600, +localStorage.getItem('musearena-player-height') || 420)); } catch {}
  let preferred=height;
  function resize(value,persist=true) {
    if(persist)preferred=value;
    const stageHeight=stage.getBoundingClientRect().height;
    const maximum = Math.max(300, Math.min(600, stageHeight - 220));
    height = Math.round(Math.min(maximum, Math.max(300, value)));
    stage.style.setProperty('--player-height', height + 'px');
    stage.classList.toggle('compact-player',height<390);
    stage.classList.toggle('compact-playlist',stageHeight-height<380);
    splitter.setAttribute('aria-valuemax', String(Math.round(maximum))); splitter.setAttribute('aria-valuenow', String(height));
    if(persist)try { localStorage.setItem('musearena-player-height', String(preferred)); } catch {}
    onResize();
  }
  function expand(expanded = true) {
    dock.classList.toggle('collapsed', !expanded);
    toggle.textContent = expanded ? 'COLLAPSE' : 'EXPAND PLAYER';
    toggle.setAttribute('aria-label', expanded ? 'Collapse player' : 'Expand player'); toggle.setAttribute('aria-expanded', String(expanded));
    if (!expanded) onCollapse(); onResize();
  }
  toggle.onclick = () => expand(dock.classList.contains('collapsed'));
  splitter.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault(); expand(true); splitter.setPointerCapture(event.pointerId);
    const move = event => resize(stage.getBoundingClientRect().bottom - event.clientY);
    const end = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', end); splitter.removeEventListener('pointercancel', end); };
    splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', end); splitter.addEventListener('pointercancel', end);
  };
  splitter.onkeydown = event => {
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault(); expand(true);
    resize(event.key === 'Home' ? 300 : event.key === 'End' ? 600 : height + (event.key === 'ArrowUp' ? 20 : -20));
  };
  splitter.ondblclick = () => expand(dock.classList.contains('collapsed'));
  window.addEventListener('resize', () => resize(preferred,false));
  new ResizeObserver(()=>resize(preferred,false)).observe(stage);resize(preferred,false);
  // Phone jump switch: scroll to the timeline or the player; highlight whichever is on screen.
  const jump = $('phoneJump');
  if (jump) {
    const buttons = [...jump.querySelectorAll('[data-jump]')];
    for (const button of buttons) button.onclick = () => {
      const target = $(button.dataset.jump);
      if (target === dock) expand(true);
      target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    };
    new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.target === dock) {
        const playerVisible = entry.isIntersecting;
        buttons.forEach(button => button.setAttribute('aria-pressed', String((button.dataset.jump === 'patternEditor') === playerVisible)));
      }
    }, { threshold: .35 }).observe(dock);
  }
  return { expand };
}

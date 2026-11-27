// Perspective projection of stacked wave traces. Depth changes their scale and baseline.
function drawWaves(g, width, height, time, reveal = 1) {
  const colors = ["#66ddbf", "#65abe8", "#af9be7", "#ff9660"];
  for (let row = 0; row < 14; row++) {
    const z = 1.9 - row * .075, scale = 1 / z;
    g.strokeStyle = colors[Math.floor(row / 4)]; g.lineWidth = Math.max(1, 2 * scale);
    g.beginPath();
    for (let i = 0; i <= 96 * reveal; i++) {
      const u = i / 96, wave = Math.sin(u * 13 + time * 1.3 + row * .23) * Math.sin(Math.PI * u);
      const x = width * (.5 + (u - .5) * 1.15 * scale);
      const y = height * (.27 + scale * .38 + wave * .25 * scale);
      if (!i) g.moveTo(x,y); else g.lineTo(x,y);
    }
    g.stroke();
  }
}
export function mountVisuals() {
  const $=id=>document.getElementById(id),root=document.documentElement,app=document.querySelector('.app');
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let motion='system',light=true,frame=0;
  try{motion=localStorage.getItem('ma-motion')||'system';light=localStorage.getItem('ma-light')!=='off';}catch{}
  if(!['system','on','off'].includes(motion))motion='system';
  const enabled=()=>motion==='on'||(motion==='system'&&!media.matches);
  const apply=()=>{root.dataset.motion=enabled()?'on':'off';root.dataset.light=light?'on':'off';$('motionSetting').value=motion;$('lightSetting').checked=light;};
  function endIntro() {
    cancelAnimationFrame(frame);$('introFilm').pause();$('intro').hidden=true;app.inert=false;
    window.removeEventListener('keydown',skip,true);
    try{sessionStorage.setItem('ma-intro-seen','1');}catch{}
  }
  function skip(event){event.preventDefault();event.stopPropagation();endIntro();}
  function intro(force=false) {
    let seen=false;try{seen=sessionStorage.getItem('ma-intro-seen')==='1';}catch{}
    if(!enabled()||(!force&&seen))return;
    cancelAnimationFrame(frame);
    const overlay=$('intro'),logo=$('introLogo'),word=$('introWord');
    overlay.hidden=false;app.inert=true;logo.classList.remove('on');word.replaceChildren(...[...'MUSEARENA'].map(letter=>{const span=document.createElement('span');span.textContent=letter;return span;}));
    const film = $('introFilm');
    const start = performance.now();
    film.currentTime = 0;
    const still = media.matches;
    if (!still) film.play().catch(() => { /* The timed title still completes if playback is unavailable. */ });
    const draw = now => {
      const elapsed = now - start;
      if (still || film.currentTime >= 1.95 || elapsed > 2500) {
        logo.classList.add('on');
        for (const letter of word.children) letter.classList.add('on');
      }
      if ((still && elapsed >= 1500) || film.ended || elapsed >= 4600) return endIntro();
      frame = requestAnimationFrame(draw);
    };
    window.addEventListener('keydown',skip,true);frame=requestAnimationFrame(draw);
  }
  $('intro').onclick=endIntro;$('skipIntro').onclick=endIntro;
  $('motionSetting').onchange=event=>{motion=event.target.value;try{localStorage.setItem('ma-motion',motion);}catch{}apply();if(!enabled())endIntro();else if(motion==='on')intro(true);};
  $('replayIntro').onclick=()=>intro(true);
  $('lightSetting').onchange=event=>{light=event.target.checked;try{localStorage.setItem('ma-light',light?'on':'off');}catch{}apply();};
  media.addEventListener('change',()=>{apply();if(!enabled())endIntro();});
  let x=-999,y=-999,queued=false;
  const illuminate=()=>{queued=false;for(const panel of document.querySelectorAll('.lit')){const bounds=panel.getBoundingClientRect();panel.style.setProperty('--mx',x-bounds.left+'px');panel.style.setProperty('--my',y-bounds.top+'px');}};
  window.addEventListener('pointermove',event=>{x=event.clientX;y=event.clientY;if(!queued){queued=true;requestAnimationFrame(illuminate);}},{passive:true});
  window.addEventListener('pointerout',event=>{if(!event.relatedTarget){x=y=-999;illuminate();}});
  const library = $('studioLibrary'), ribbon = $('studioWave');
  let ribbonFrame;
  function redrawLibrary() {
    cancelAnimationFrame(ribbonFrame);
    if (!library.open) return;
    const g = ribbon.getContext('2d');
    const moving = enabled() && !media.matches;
    const start = performance.now();
    const draw = now => {
      g.clearRect(0,0,ribbon.width,ribbon.height);
      drawWaves(g,ribbon.width,ribbon.height,moving ? (now-start)/1000 : 0);
      if (moving && library.open) ribbonFrame=requestAnimationFrame(draw);
    };
    draw(start);
  }
  new MutationObserver(redrawLibrary).observe(library,{attributes:true,attributeFilter:['open']});
  media.addEventListener('change',redrawLibrary);
  function press(control) {
    if (!control || control.disabled || !enabled() || media.matches) return;
    control.animate([{scale:'.965'}, {scale:'1'}], {duration:140, easing:'ease-out'});
  }
  document.addEventListener('pointerdown', event => {
    if (event.button === 0) press(event.target.closest('button'));
  }, {passive:true});
  document.addEventListener('click', event => {
    if (event.detail === 0) press(event.target.closest('button'));
  });
  const theme = $('themeSetting'), systemTheme = matchMedia('(prefers-color-scheme: dark)');
  try { theme.value = localStorage.getItem('ma-theme') || 'system'; } catch {}
  const switches = document.querySelectorAll('.theme-switch');
  function applyTheme() {
    root.dataset.theme = theme.value === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme.value;
    for (const control of switches) control.setAttribute('aria-checked', String(root.dataset.theme === 'dark'));
  }
  for (const control of switches) control.onclick = () => {
    theme.value = root.dataset.theme === 'dark' ? 'light' : 'dark';
    theme.dispatchEvent(new Event('change'));
  };
  theme.onchange = () => {
    try { localStorage.setItem('ma-theme', theme.value); } catch {}
    applyTheme();
  };
  systemTheme.addEventListener('change', applyTheme);
  applyTheme();
  apply();intro(new URLSearchParams(location.search).has('intro'));
  return {intro};
}

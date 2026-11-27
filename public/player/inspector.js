import { FX_DEF, defaultFx, delaySeconds } from './effects.js';
const $=id=>document.getElementById(id);
const format=(key,value)=>key==='gain'&&value<=-60?'−∞ dB':key==='pan'?(Math.abs(value)<.01?'C':(value<0?'L':'R')+Math.round(Math.abs(value)*100)):key==='dRep'?(value?value+'×':'OFF'):key==='dMix'?Math.round(value*100)+'%':value.toFixed(key==='dTime'?0:1)+(FX_DEF[key].unit?' '+FX_DEF[key].unit:'');

export function mountInspector({getTarget,getBpm,onChange}) {
  let scope='lane',lastTarget=null;
  function render() {
    const target=getTarget();if(!target?.lane)return;
    const identity=target.clip||target.lane;
    if(lastTarget!==identity){lastTarget=identity;scope=target.clip?.fx?'clip':'lane';}
    $('inspectorTarget').textContent=target.clip?'Clip · '+target.name:target.lane.name;
    $('fxScope').value=scope;$('fxScope').options[1].disabled=!target.clip;
    $('fxInherit').hidden=scope!=='clip';
    const owner=scope==='clip'?target.clip:target.lane;
    const values=()=>({...defaultFx(),...target.lane.fx,...(scope==='clip'?target.clip?.fx:{})});
    function set(key,value) { owner.fx={...values(),[key]:value};onChange(); }
    const box=$('fxControls');box.replaceChildren();
    for(const [label,icon,keys] of [['Gain','gain',['gain','pan']],['EQ','eq',['low','mid','high']],['Delay','delay',['dTime','dRep','dMix']]]) {
      const group=document.createElement('section');group.className='fx-group';
      const heading=document.createElement('h3');heading.className='lab';heading.innerHTML=`<svg class="i"><use href="#i-${icon}"/></svg>`;heading.append(document.createTextNode(label));group.append(heading);
      const row=document.createElement('div');row.className='knob-row';
      for(const key of keys) {
        const def=FX_DEF[key],el=document.createElement('div');el.className='knob';el.tabIndex=0;el.dataset.param=key;
        el.setAttribute('role','slider');el.setAttribute('aria-label',def.label);el.setAttribute('aria-valuemin',def.min);el.setAttribute('aria-valuemax',def.max);
        el.title='Drag vertically · Shift fine · wheel · arrows · double-click reset';
        el.innerHTML='<div class="knob-face"><i></i><b></b></div><div class="knob-value mono"></div><div class="lab"></div>';
        el.lastChild.textContent=def.label;
        const paint=()=>{
          const value=values()[key],fraction=(value-def.min)/(def.max-def.min),locked=key==='dTime'&&values().sync!=='off';
          const shown=locked?delaySeconds(values(),getBpm())*1000:value;
          el.querySelector('i').style.transform=`rotate(${-135+fraction*270}deg)`;el.querySelector('b').style.width=fraction*100+'%';
          el.querySelector('.knob-value').textContent=format(key,shown);el.setAttribute('aria-valuenow',String(value));el.setAttribute('aria-valuetext',format(key,shown));
          el.setAttribute('aria-disabled',String(locked));el.tabIndex=locked?-1:0;
        };
        const change=value=>{if(key==='dTime'&&values().sync!=='off')return;set(key,+Math.max(def.min,Math.min(def.max,Math.round(value/def.step)*def.step)).toFixed(4));paint();};
        el.onpointerdown=event=>{
          if(event.button!==0)return;event.preventDefault();el.focus();el.setPointerCapture(event.pointerId);
          const y=event.clientY,value=values()[key];
          el.onpointermove=move=>change(value+(y-move.clientY)*(def.max-def.min)/(move.shiftKey?800:160));
          const end=()=>{el.onpointermove=null;};el.onpointerup=end;el.onpointercancel=end;
        };
        el.onwheel=event=>{event.preventDefault();change(values()[key]+(event.deltaY<0?def.step:-def.step));};
        el.ondblclick=()=>change(def.value);
        el.onkeydown=event=>{const direction={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1}[event.key];if(direction||['Home','End'].includes(event.key)){event.preventDefault();change(event.key==='Home'?def.min:event.key==='End'?def.max:values()[key]+direction*def.step*(event.shiftKey?1:4));}};
        paint();row.append(el);
      }
      group.append(row);box.append(group);
    }
    $('fxSync').value=values().sync;$('fxPingPong').checked=values().pingPong;
    $('fxSync').onchange=event=>{set('sync',event.target.value);render();};
    $('fxPingPong').onchange=event=>set('pingPong',event.target.checked);
  }
  $('fxScope').onchange=event=>{scope=event.target.value;const {lane,clip}=getTarget();if(scope==='clip'&&clip&&!clip.fx)clip.fx={...defaultFx(),...lane.fx};render();onChange();};
  $('fxInherit').onclick=()=>{const {clip}=getTarget();if(clip)delete clip.fx;scope='lane';render();onChange();};
  render();return{render};
}

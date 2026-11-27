export const FX_DEF = {
  gain:{label:'Gain',min:-60,max:12,step:.5,value:0,unit:'dB'},pan:{label:'Pan',min:-1,max:1,step:.02,value:0,unit:''},
  low:{label:'Bass',min:-12,max:12,step:.5,value:0,unit:'dB'},mid:{label:'Mid',min:-12,max:12,step:.5,value:0,unit:'dB'},high:{label:'Treble',min:-12,max:12,step:.5,value:0,unit:'dB'},
  dTime:{label:'Time',min:1,max:2000,step:1,value:333,unit:'ms'},dRep:{label:'Repeats',min:0,max:16,step:1,value:0,unit:'×'},dMix:{label:'Mix',min:0,max:1,step:.01,value:.35,unit:''},
};
export const defaultFx = () => ({...Object.fromEntries(Object.entries(FX_DEF).map(([key,def])=>[key,def.value])),sync:'off',pingPong:false});
export function validateFx(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid project: effects');
  const result=defaultFx();
  for (const [key,def] of Object.entries(FX_DEF)) {
    if (!Number.isFinite(raw[key]) || raw[key]<def.min || raw[key]>def.max || (key==='dRep' && !Number.isInteger(raw[key]))) throw new Error('Invalid project: '+key+' effect');
    result[key]=raw[key];
  }
  if (!['off','1/16','1/8','1/4','1/2'].includes(raw.sync) || typeof raw.pingPong!=='boolean') throw new Error('Invalid project: delay options');
  result.sync=raw.sync;result.pingPong=raw.pingPong;return result;
}
export const delayFeedback = repeats => repeats>0 ? Math.pow(.001,1/repeats) : 0;
export const delaySeconds = (fx,bpm) => Math.max(.001,Math.min(2,fx.sync==='off' ? fx.dTime/1000 : 60/bpm*4*({'1/16':1/16,'1/8':1/8,'1/4':1/4,'1/2':1/2}[fx.sync]||1/4)));
export function createEffectsGraph(context,destination,initial=defaultFx(),bpm=90) {
  const nodes=[];
  const node=method=>{const value=context[method]();nodes.push(value);return value;};
  const input=node('createGain'),gain=node('createGain'),low=node('createBiquadFilter'),mid=node('createBiquadFilter'),high=node('createBiquadFilter'),pan=node('createStereoPanner');
  low.type='lowshelf';low.frequency.value=200;mid.type='peaking';mid.frequency.value=1000;mid.Q.value=.8;high.type='highshelf';high.frequency.value=4000;
  input.connect(gain).connect(low).connect(mid).connect(high).connect(pan).connect(destination);
  const makeDelay=()=>{const value=context.createDelay(2);nodes.push(value);return value;};
  const normalSend=node('createGain'),normal=makeDelay(),fb=node('createGain'),normalWet=node('createGain');
  pan.connect(normalSend).connect(normal);normal.connect(fb).connect(normal);normal.connect(normalWet).connect(destination);
  const ppSend=node('createGain'),left=makeDelay(),right=makeDelay(),fbLeft=node('createGain'),fbRight=node('createGain'),leftPan=node('createStereoPanner'),rightPan=node('createStereoPanner'),ppWet=node('createGain');
  ppSend.channelCount=1;ppSend.channelCountMode='explicit';leftPan.pan.value=-1;rightPan.pan.value=1;
  pan.connect(ppSend).connect(left);left.connect(fbLeft).connect(right);right.connect(fbRight).connect(left);
  left.connect(leftPan).connect(ppWet);right.connect(rightPan).connect(ppWet);ppWet.connect(destination);
  function update(value,bpm=90,smooth=true) {
    const f={...defaultFx(),...value},now=context.currentTime,set=(param,value)=>{if(smooth)param.setTargetAtTime(value,now,.015);else param.value=value;};
    set(gain.gain,f.gain<=-60?0:Math.pow(10,f.gain/20));set(pan.pan,f.pan);set(low.gain,f.low);set(mid.gain,f.mid);set(high.gain,f.high);
    const enabled=f.dRep>0,time=delaySeconds(f,bpm),feedback=delayFeedback(f.dRep);
    for(const delay of [normal,left,right])set(delay.delayTime,time);
    set(normalSend.gain,enabled&&!f.pingPong?1:0);set(normalWet.gain,enabled&&!f.pingPong?f.dMix:0);set(fb.gain,enabled&&!f.pingPong?feedback:0);
    set(ppSend.gain,enabled&&f.pingPong?1:0);set(ppWet.gain,enabled&&f.pingPong?f.dMix:0);set(fbLeft.gain,enabled&&f.pingPong?feedback:0);set(fbRight.gain,enabled&&f.pingPong?feedback:0);
  }
  update(initial,bpm,false);
  return {input,update,nodes:{gain,pan,low,mid,high,normal,fb,left,right,fbLeft,fbRight,normalWet,ppWet},dispose(){for(const value of nodes)value.disconnect();}};
}

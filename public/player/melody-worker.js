// Magenta basic_rnn: two BasicLSTMCell layers followed by a 38-event softmax.
// Matrix rows and gate order match TensorFlow's checkpoint (input, candidate, forget, output).
const units = 512, gates = 4 * units;
const sigmoid = x => 1 / (1 + Math.exp(-x));
function cell(kernel, bias) {
  const h = new Float32Array(units), c = new Float32Array(units), sums = new Float32Array(gates);
  return input => {
    sums.set(bias);
    let row = 0;
    for (const vector of [input, h]) {
      for (const value of vector) {
        if (value !== 0) for (let j=0; j<gates; j++) sums[j] += value * kernel[row+j];
        row += gates;
      }
    }
    for (let j=0; j<units; j++) {
      c[j] = c[j]*sigmoid(sums[j+2*units]+1) + sigmoid(sums[j])*Math.tanh(sums[j+units]);
      h[j] = Math.tanh(c[j])*sigmoid(sums[j+3*units]);
    }
    return h;
  };
}
self.onmessage = async ({data:{steps, primer}}) => {
  try {
    const response = await fetch('./model/melody.bin');
    if (!response.ok) throw Error();
    const weights = new Float32Array(await response.arrayBuffer());
    let offset = 0;
    const take = n => weights.subarray(offset,offset+=n);
    const b2=take(gates), k1=take(550*gates), b1=take(gates), projection=take(units*38);
    const k2=take(1024*gates), bias=take(38);
    if (weights.length!==offset) throw Error();
    const first=cell(k1,b1), second=cell(k2,b2), input=new Float32Array(38);
    const events=[...primer];
    for(let step=0;step<steps-1;step++) {
      input.fill(0); input[events[step]]=1;
      const state=second(first(input));
      if(step+1<primer.length) continue;
      const probs=Float64Array.from(bias);
      for(let i=0;i<units;i++) for(let j=0;j<38;j++) probs[j]+=state[i]*projection[i*38+j];
      const max=Math.max(...probs);
      let sum=0;
      for(let j=0;j<38;j++) sum+=probs[j]=Math.exp((probs[j]-max)/.95);
      let draw=Math.random()*sum, token=0;
      while(token<37 && (draw-=probs[token])>0) token++;
      events.push(token);
    }
    self.postMessage({events});
  } catch { self.postMessage({error:'Could not load the melody model. Check your connection and try again.'}); }
};

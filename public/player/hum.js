const $ = id => document.getElementById(id);

// Capture stays local until STOP HUM. No microphone is monitored through speakers.
export function mountHum({ getTarget, onStart, onResult, onVoice, onState, onShow }) {
  const button = $('humBtn'), cancel = $('humCancel'), meter = $('humLevel');
  let voice = false;
  const voiceButton = $('voiceRecord');
  let state = 'idle', recorder, stream, inputContext, frame, timer, chunks = [], session = 0, request, blocked = false;
  const message = (text, error = false) => { $('humStatus').textContent = text; $('humStatus').classList.toggle('error', error); };
  function setState(next) {
    state = next; button.disabled = blocked || ['requesting','uploading'].includes(state);
    button.querySelector('span').textContent = state === 'recording' ? 'STOP HUM' : state === 'uploading' ? 'CONVERTING' : 'HUM';
    if (voice && state !== 'idle') { button.disabled = true; button.querySelector('span').textContent = 'HUM'; }
    voiceButton.disabled = blocked || (state !== 'idle' && (!voice || state !== 'recording'));
    voiceButton.textContent = voice && state === 'recording' ? 'Stop recording' : 'Record voice';
    button.setAttribute('aria-pressed', String(!voice && state === 'recording'));
    meter.classList.toggle('active', state !== 'idle');
    cancel.hidden = state === 'idle';
    $('humSnap').disabled = $('humMinNote').disabled = state !== 'idle'; onState(state);
  }
  function release() {
    clearTimeout(timer); cancelAnimationFrame(frame); meter.value = 0;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    inputContext?.close().catch(() => {}); inputContext = null;
  }
  function cancelRecording() {
    session++; request?.abort();
    if (recorder?.state === 'recording') recorder.stop();
    release(); setState('idle'); message('Hum cancelled.');
  }
  async function start(recordVoice = false) {
    if (blocked) return;
    voice = recordVoice; onShow();
    const id = ++session;
    try {
      const target = getTarget();
      if (!voice && (!target.instrument || target.instrument.kind !== 'melodic')) throw new Error('Choose a keyboard instrument for your hummed tune.');
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Microphone recording is unavailable. Open MuseArena on localhost or HTTPS in a supported browser.');
      onStart(); setState('requesting'); message('Allow microphone access to hum a tune.');
      const captured = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (id !== session) { captured.getTracks().forEach(track => track.stop()); return; }
      stream = captured; chunks = [];
      const types = ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4','audio/webm'];
      const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const snapKey = $('humSnap').value, minNoteMs = Math.max(20, Math.min(1000, +$('humMinNote').value || 80));
      inputContext = new AudioContext(); await inputContext.resume();
      const analyser = inputContext.createAnalyser(); analyser.fftSize = 1024;
      inputContext.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const level = () => {
        if (id !== session || !inputContext) return;
        analyser.getFloatTimeDomainData(data); meter.value = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
        frame = requestAnimationFrame(level);
      };
      recorder.ondataavailable = event => { if (id === session && event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { if (id === session) { cancelRecording(); message('Microphone recording failed. Try again.', true); } };
      recorder.onstop = async () => {
        if (id !== session) return; release();
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        try {
          if (blob.size <= 1000) throw new Error('The recording was too short. Hum for at least a second.');
          if (blob.size > 20000000) throw new Error('The recording exceeds 20 MB. Try a shorter tune.');
          if (voice) {
            setState('uploading'); message('Adding your recording to the timeline…');
            const file = new File([blob], 'Voice take.' + (blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'), {type:blob.type});
            const pattern = await onVoice(file);
            if (!pattern) throw Error($('status').textContent);
            $('voicePlayback').hidden = false;
            message('Voice take added. Press play in Voice to hear the recording.'); return;
          }
        } catch (error) { if (id === session && error.name !== 'AbortError') message(error.message, true); }
        finally { if (id === session) setState('idle'); }
      };
      recorder.start(250); setState('recording'); level();
      message(voice ? "Recording your voice. Press Stop recording when finished." : `Humming → ${target.instrument.name}. Press STOP HUM when finished.`);
      timer = setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 120000);
    } catch (error) {
      if (id !== session) return;
      release(); setState('idle'); message(error.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in browser settings and try HUM again.' : error.message, true);
    }
  }
  button.onclick = () => { if (state === 'recording' && recorder.state === 'recording') { button.disabled = true; recorder.stop(); } else if (state === 'idle') start(); };
  voiceButton.onclick = () => {
    if (voice && recorder?.state === 'recording') recorder.stop();
    else if (state === 'idle') start(true);
  };
  cancel.onclick = cancelRecording;
  window.addEventListener('pagehide', cancelRecording);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && state !== 'idle') cancelRecording(); });
  setState('idle');
  return { cancel: cancelRecording, setBlocked(value) { blocked = value; setState(state); } };
}

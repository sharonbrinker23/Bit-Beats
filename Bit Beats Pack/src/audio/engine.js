/* Bit Beats — the Web Audio graph: per-track chains, voice factories and playNote
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const midiToFreq = (...a)=> BB.midiToFreq(...a), clampedBendEndStep = (...a)=> BB.clampedBendEndStep(...a),
      clampedBendStartStep = (...a)=> BB.clampedBendStartStep(...a), stepDurSec = (...a)=> BB.stepDurSec(...a);
/* ======================================================================
   AUDIO ENGINE
   ====================================================================== */
const actx = new (window.AudioContext||window.webkitAudioContext)();
const masterGain = actx.createGain(); masterGain.gain.value = 0.9; masterGain.connect(actx.destination);

function makeReverbBuffer(seconds){
  const rate = actx.sampleRate, len = rate*seconds, buf = actx.createBuffer(2,len,rate);
  for(let ch=0; ch<2; ch++){ const d = buf.getChannelData(ch);
    for(let i=0;i<len;i++){ d[i] = (Math.random()*2-1) * Math.pow(1-i/len, 2.5); } }
  return buf;
}
const reverbBuffer = makeReverbBuffer(2.2);

// builds one track-shaped audio graph (input -> eq -> reverb send/dry -> pan -> destination) on
// whichever context/destination/reverb impulse it's given — shared by the live per-track chain
// (buildChain, below) and by offline rendering for WAV export, which can't reuse actx's own nodes
// since every node in a graph must belong to the same (Offline)AudioContext as its destination
function makeChain(ctx, reverbBuf, destination){
  const eqLow = ctx.createBiquadFilter(); eqLow.type="lowshelf"; eqLow.frequency.value=320;
  const eqMid = ctx.createBiquadFilter(); eqMid.type="peaking"; eqMid.frequency.value=1200; eqMid.Q.value=0.9;
  const eqHigh = ctx.createBiquadFilter(); eqHigh.type="highshelf"; eqHigh.frequency.value=3200;
  const input = ctx.createGain();
  const dry = ctx.createGain(), wet = ctx.createGain();
  const conv = ctx.createConvolver(); conv.buffer = reverbBuf;
  const trackOut = ctx.createGain();
  const panNode = ctx.createStereoPanner();
  input.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
  eqHigh.connect(dry); dry.connect(trackOut);
  eqHigh.connect(conv); conv.connect(wet); wet.connect(trackOut);
  trackOut.connect(panNode); panNode.connect(destination);
  return {input,eqLow,eqMid,eqHigh,dry,wet,trackOut,panNode};
}
// build (or rebuild) a track's persistent audio chain: input -> eq -> reverb send/dry -> pan -> master
function buildChain(track){
  track._chain = makeChain(actx, reverbBuffer, masterGain);
  applyInstrumentToChain(track);
}
function applyInstrumentToChain(track){
  const c = track._chain; if(!c) return;
  const inst = track.instrument;
  c.eqLow.gain.value = inst.eqLow; c.eqMid.gain.value = inst.eqMid; c.eqHigh.gain.value = inst.eqHigh;
  const wetAmt = inst.reverb/100;
  c.dry.gain.value = 1-wetAmt*0.6; c.wet.gain.value = wetAmt;
  c.trackOut.gain.value = (track.muted?0:1) * track.volume;
  c.panNode.pan.value = (track.pan-50)/50;
}

let noiseBufferCache=null;
function getNoiseBuffer(){
  if(noiseBufferCache) return noiseBufferCache;
  const len = actx.sampleRate*1; const buf = actx.createBuffer(1,len,actx.sampleRate);
  const d = buf.getChannelData(0); for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
  noiseBufferCache = buf; return buf;
}

// every currently-sounding voice, so playback can be cut dead on pause/stop instead of letting
// already-scheduled envelopes/oscillators ring out to their natural end
BB.activeVoices = [];

/* ---------- the audio target ----------
   Everything a voice has to be BUILT ON, gathered into one shape: the context that must own every node
   it creates, the track chain those nodes feed, and a noise buffer that same context can legally play.
   Two things satisfy it — the live context (liveTarget) and an offline render (renderTarget) — and
   playNote below can no longer tell them apart, because it never reaches for actx or track._chain. */
// renderCtx (optional) lets offline WAV export reuse this exact synthesis logic against an
// OfflineAudioContext + its own per-track chain, instead of the live actx/track._chain — every node
// in a graph must belong to the same (Offline)AudioContext as its destination, so live playback and
// export can't share actual nodes, only this function's logic
function liveTarget(track){
  if(!track._chain) buildChain(track);
  // noiseBuffer stays a getter so it is still built on the first NOISE note rather than on the first
  // note of any kind — that laziness used to live in the getNoiseBuffer() call inside the noise branch
  return {ctx: actx, chain: track._chain, live: true, get noiseBuffer(){ return getNoiseBuffer(); }};
}
function renderTarget(ctx, chain, noiseBuffer){
  return {ctx, chain, noiseBuffer, live: false};
}

/* ---------- voice factories ----------
   One builder per waveform. A builder creates its nodes on the target's context, wires them into the
   envelope it is handed, applies its own kind of bend and starts/stops itself, then hands the source
   back. Each waveform bends a DIFFERENT parameter — noise bends its bandpass filter's frequency, a
   custom sample bends playbackRate, an oscillator bends frequency — which is exactly why these are
   separate builders rather than one function with a chain of ifs inside it.
   Adding a waveform is a register() call; playNote() never learns the new name. A builder may also
   DECLINE a note by returning null, which falls it through to the default oscillator builder: that is
   how the custom-sample voice reproduces the old chain's `wave==="custom" && customBuffer` guard. */
const VoiceFactories = (function(){
  const byWave = {};
  let defaultBuild = null;
  return {
    register(wave, build){ byWave[wave] = build; },
    registerDefault(build){ defaultBuild = build; },
    build(ctx, spec){
      const factory = byWave[spec.inst.wave];
      const source = factory ? factory(ctx, spec) : null;
      return source!=null ? source : defaultBuild(ctx, spec);
    }
  };
})();

VoiceFactories.register("custom", (ctx, spec)=>{
  const inst = spec.inst;
  if(!inst.customBuffer) return null;
  const src = ctx.createBufferSource(); src.buffer = inst.customBuffer;
  src.playbackRate.setValueAtTime(Math.pow(2,(spec.midi-inst.customBaseMidi)/12), spec.startTime);
  if(spec.hasBend){
    src.playbackRate.setValueAtTime(Math.pow(2,(spec.midi-inst.customBaseMidi)/12), spec.bendAt);
    src.playbackRate.linearRampToValueAtTime(Math.pow(2,(spec.bendToMidi-inst.customBaseMidi)/12), spec.bendDoneAt);
  }
  src.connect(spec.env); src.start(spec.startTime); src.stop(spec.stopAt);
  return src;
});
VoiceFactories.register("noise", (ctx, spec)=>{
  const src = ctx.createBufferSource(); src.buffer = spec.noiseBuffer; src.loop=true;
  const bp = ctx.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=1.2;
  bp.frequency.setValueAtTime(midiToFreq(spec.midi)*2, spec.startTime);
  if(spec.hasBend){
    bp.frequency.setValueAtTime(midiToFreq(spec.midi)*2, spec.bendAt);
    bp.frequency.linearRampToValueAtTime(midiToFreq(spec.bendToMidi)*2, spec.bendDoneAt);
  }
  src.connect(bp); bp.connect(spec.env);
  src.start(spec.startTime); src.stop(spec.stopAt);
  return src;
});
// approximate pulse wave via two detuned sawtooths (poor-man's PWM) -> simpler: use square with custom periodic wave
function pulseVoiceFactory(duty){
  return (ctx, spec)=>{
    const osc = ctx.createOscillator();
    const real = new Float32Array(16), imag = new Float32Array(16);
    for(let n=1;n<16;n++){ real[n]=0; imag[n]=(2/(n*Math.PI))*Math.sin(n*Math.PI*duty); }
    const wave = ctx.createPeriodicWave(real,imag,{disableNormalization:false});
    osc.setPeriodicWave(wave);
    osc.frequency.setValueAtTime(midiToFreq(spec.midi), spec.startTime);
    if(spec.hasBend){
      osc.frequency.setValueAtTime(midiToFreq(spec.midi), spec.bendAt);
      osc.frequency.linearRampToValueAtTime(midiToFreq(spec.bendToMidi), spec.bendDoneAt);
    }
    osc.connect(spec.env); osc.start(spec.startTime); osc.stop(spec.stopAt);
    return osc;
  };
}
VoiceFactories.register("pulse25", pulseVoiceFactory(0.25));
VoiceFactories.register("pulse12", pulseVoiceFactory(0.125));
// square / triangle / sawtooth / sine differ only by osc.type, so one builder covers all four — and it
// doubles as the fallback for any wave no other builder claimed, exactly like the old trailing `else`
VoiceFactories.registerDefault((ctx, spec)=>{
  const osc = ctx.createOscillator();
  osc.type = spec.inst.wave;
  osc.frequency.setValueAtTime(midiToFreq(spec.midi), spec.startTime);
  if(spec.hasBend){
    osc.frequency.setValueAtTime(midiToFreq(spec.midi), spec.bendAt);
    osc.frequency.linearRampToValueAtTime(midiToFreq(spec.bendToMidi), spec.bendDoneAt);
  }
  osc.connect(spec.env); osc.start(spec.startTime); osc.stop(spec.stopAt);
  return osc;
});

// the note-shaped half of a playNote() call — {midi, startTime, durSec} plus the three optional bend
// fields — as ONE value object, so a caller with no bend to describe leaves those fields out instead
// of passing a run of null/undefined holes. Both schedulers (live and offline) build theirs from the
// very same note record, which is why that translation lives here rather than in each of them.
function noteVoice(note, startTime){
  return {
    midi: note.pitch, startTime, durSec: note.dur*stepDurSec()*0.92,
    bendToMidi: note.bendTo,
    bendDelaySec: clampedBendStartStep(note)*stepDurSec(),
    bendEndSec: clampedBendEndStep(note)*stepDurSec()
  };
}
// `voice` is that value object; `target` is the audio target above — the only two things a voice needs
function playNote(track, voice, target){
  const ctx = target.ctx;
  const chain = target.chain;
  const inst = track.instrument;
  const midi = voice.midi, startTime = voice.startTime, durSec = voice.durSec;
  const bendToMidi = voice.bendToMidi, bendDelaySec = voice.bendDelaySec, bendEndSec = voice.bendEndSec;
  const env = ctx.createGain();
  env.connect(chain.input);
  const atk = Math.max(0.001, inst.attack/1000), rel = Math.max(0.005, inst.release/1000);
  const peak = 0.5*inst.volume;
  env.gain.setValueAtTime(0,startTime);
  env.gain.linearRampToValueAtTime(peak, startTime+atk);
  const sustainEnd = Math.max(startTime+atk, startTime+durSec);
  env.gain.setValueAtTime(peak, sustainEnd);
  env.gain.linearRampToValueAtTime(0.0001, sustainEnd+rel);
  const stopAt = sustainEnd+rel+0.02;
  const hasBend = bendToMidi!=null && bendToMidi!==midi;
  // the slide holds at the original pitch until the bend-start dot's point in time, then ramps to the
  // target pitch by the bend-end point (the stub's left edge) — both clamped to stay inside the note
  // and in the right order, so dragging either one never produces a backwards or zero-length ramp
  const bendAt = Math.min(sustainEnd-0.01, startTime+Math.max(0,bendDelaySec||0));
  const bendDoneAt = Math.max(bendAt+0.01, Math.min(sustainEnd, startTime+(bendEndSec==null?durSec:bendEndSec)));
  const source = VoiceFactories.build(ctx, {
    inst, env, midi, bendToMidi, hasBend, startTime, stopAt, bendAt, bendDoneAt,
    get noiseBuffer(){ return target.noiseBuffer; }
  });

  if(!target.live) return; // offline render: no live-voice bookkeeping needed, nothing to silence early
  // opportunistic cleanup of long-finished voices, so this array doesn't grow unbounded over a long session
  BB.activeVoices = BB.activeVoices.filter(v=> v.stopAt > actx.currentTime);
  BB.activeVoices.push({env, source, stopAt});
}

// immediately silences every voice currently sounding — used on pause/stop so notes don't ring out
// past where the transport actually stopped
function silenceAllVoices(){
  const now = actx.currentTime;
  BB.activeVoices.forEach(v=>{
    try{ v.env.gain.cancelScheduledValues(now); v.env.gain.setValueAtTime(0, now); }catch(e){}
    try{ v.source.stop(now); }catch(e){}
  });
  BB.activeVoices = [];
}

// a short percussive click for the metronome — sent straight to the master bus rather than through any
// track's chain, so it's always audible regardless of mute/solo and isn't affected by track automation
function playClick(time, accented){
  const osc = actx.createOscillator();
  const gain = actx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(accented ? 1600 : 1000, time);
  gain.gain.setValueAtTime(accented ? 0.4 : 0.28, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time+0.045);
  osc.connect(gain); gain.connect(masterGain);
  osc.start(time); osc.stop(time+0.05);
}

/* exported to the shared namespace */
Object.assign(BB, { actx, applyInstrumentToChain, buildChain, liveTarget, makeChain, masterGain, noteVoice,
                    playClick, playNote, renderTarget, silenceAllVoices });
})();

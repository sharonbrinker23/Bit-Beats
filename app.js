(function(){
"use strict";

/* ======================================================================
   CONSTANTS / MUSIC THEORY
   ====================================================================== */
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const OCT_MIN = 0, OCT_MAX = 7;
const ROW_H = 18;
const GRID_RULER_H = 18; // reserved band at the top of the piano roll for the bar-number ruler — real
// space (not an overlay), so no note row ever shares pixels with it; must match #gridRuler's CSS height
let STEP_W = 26;
const STEP_W_MIN = 5, STEP_W_MAX = 70;
const STEPS_TOTAL_BASE = 256; // 16th-note steps available on the grid (~16 bars @4/4)
let STEPS_TOTAL = STEPS_TOTAL_BASE; // grows automatically as content extends past the current end
const SCALES = {
  Major:[0,2,4,5,7,9,11], Minor:[0,2,3,5,7,8,10], Dorian:[0,2,3,5,7,9,10],
  Phrygian:[0,1,3,5,7,8,10], Lydian:[0,2,4,6,7,9,11], Mixolydian:[0,2,4,5,7,9,10],
  Locrian:[0,1,3,5,6,8,10], Chromatic:[0,1,2,3,4,5,6,7,8,9,10,11]
};
const TRACK_COLORS = ["#5ee6a8","#6fa8ff","#ff9d6f","#e26fd8","#ffd166","#6fe2ff","#ff6b6b","#b48cff"];

function midiToName(m){ const o=Math.floor(m/12)-1; return NOTE_NAMES[m%12]+o; }
function midiToFreq(m){ return 440*Math.pow(2,(m-69)/12); }
function rowIndexToMidi(rowIndex, totalRows){ // row 0 = top = highest pitch
  const topMidi = (OCT_MAX+1)*12 + 11 - 12; // start near top
  return topMidi - rowIndex;
}

/* ======================================================================
   STATE
   ====================================================================== */
let state = {
  bpm:120, timeSig:[4,4], key:"C", mode:"Major", octaveFocus:4, noteLenSteps:4, projectTitle:"Bit Beats Project",
  // uploaded audio samples belong to the PROJECT, not to whichever track happened to load them: several
  // tracks can point at one upload, and the sample manager renames them in one place (see the CUSTOM
  // SAMPLE REGISTRY section). Shape: [{id, name, buffer}] — `buffer` is a decoded AudioBuffer and is
  // therefore runtime-only, never serialized.
  samples: [],
  tracks: [], selectedTrackId:null, clipboard:[], trackClipboard:null, playing:false, playStartStep:0,
  loop:{enabled:false, start:0, end:16}, advancedTrackId:null, advancedParam:"volume",
  metronomeOn:false, holdPositionOnPause:false
};
let selectedNoteIds = new Set();
let selectedRegionIds = new Set(); // shift-selected split-region blocks in the track list
let selectedAutoPointIds = new Set(); // selected automation dots in the advanced track editor
// {step,row} of an empty grid cell "selected" via double-click, purely for keyboard navigation — lets
// arrow keys explore empty cells without creating or moving any real note. Mutually exclusive with
// selectedNoteIds: entering/exiting always keeps exactly one of the two non-empty (never both)
let phantomSelection = null;
// tracks a note that was just placed by a single, un-dragged click on an empty cell — a genuine
// double-click on empty space fires that same placement (via the first click) followed immediately by
// this dblclick handler seeing a "hit" note that only exists because of it. Within a short window this
// is treated as a no-op double-click on empty space (toggling phantom mode) rather than a real
// double-click-to-delete of a pre-existing note.
let justPlacedNoteId = null, justPlacedAt = 0;
const JUST_PLACED_WINDOW_MS = 700;
let nextTrackId=1, nextNoteId=1, nextSampleId=1;
let editContext = "notes"; // "notes" or "track" — decides what Ctrl+C/Ctrl+V act on
// throttles Ctrl+V so holding/mashing it can't fire dozens of paste-and-rerender cycles a second
let lastPasteAt = 0;
const PASTE_COOLDOWN_MS = 200;
function pasteOnCooldown(){
  const now = performance.now();
  if(now-lastPasteAt < PASTE_COOLDOWN_MS) return true;
  lastPasteAt = now;
  return false;
}

function defaultInstrument(){
  // sampleId names an entry in state.samples; customBuffer is that entry's decoded AudioBuffer, cached
  // on the instrument so playNote() can stay a single `inst.customBuffer` lookup on the audio path
  return { wave:"square", volume:0.8, attack:5, release:80, eqLow:0, eqMid:0, eqHigh:0, reverb:0,
           customSampleData:null, customBaseMidi:60, sampleId:null };
}
function defaultAutomation(){
  return { volume:[], pan:[], reverb:[], eqLow:[], eqMid:[], eqHigh:[] };
}
function makeTrack(name, colorIdx){
  return { id: nextTrackId++, name: name||("Track "+nextTrackId), color: TRACK_COLORS[colorIdx % TRACK_COLORS.length],
           instrument: defaultInstrument(), notes: [], muted:false, solo:false, volume:0.8, pan:50, regions:null,
           automation: defaultAutomation() };
}

/* ======================================================================
   CUSTOM SAMPLE REGISTRY

   One list of uploads per project (state.samples), so a sample has a NAME that outlives the track that
   loaded it — that name is what both waveform dropdowns and the sample manager show, and renaming it in
   one place renames it everywhere. A track still carries its own decoded buffer on
   instrument.customBuffer, exactly as before, so the audio path (playNote) is untouched; sampleId is
   the back-reference that says WHICH registry entry that buffer came from.
   ====================================================================== */
function findSample(id){
  if(id==null) return null;
  return state.samples.find(s=>s.id===id) || null;
}
function registerSample(name, buffer){
  const entry = {id: nextSampleId++, name: (name||"Sample").trim() || "Sample", buffer};
  state.samples.push(entry);
  return entry;
}
function applySampleToTrack(track, entry){
  track.instrument.wave = "custom";
  track.instrument.sampleId = entry.id;
  track.instrument.customBuffer = entry.buffer;
}
// AudioBuffers are runtime objects that never survive a round trip through plain data, so every path
// that rebuilds tracks from plain data (undo snapshots, loadProject) has to re-point customBuffer at
// the registry entry the instrument's sampleId names. A sampleId with no entry behind it is left
// alone rather than cleared — the project may simply have been loaded without its audio.
function resolveTrackSample(track){
  const s = findSample(track.instrument.sampleId);
  if(s) track.instrument.customBuffer = s.buffer;
}

/* ======================================================================
   UNDO / REDO
   ====================================================================== */
let undoStack = [], redoStack = [];
let historyArmed = false;
function cloneAutomation(automation){
  const out = {};
  Object.keys(automation).forEach(k=>{ out[k] = automation[k].map(p=>({...p})); });
  return out;
}
function snapshotTracks(){
  return {
    selectedTrackId: state.selectedTrackId,
    // the mode rides along because switching it now REWRITES pitches (see transposeProjectToMode):
    // restoring the notes without restoring the mode would leave the Mode select claiming "Minor" over
    // a project whose notes are back in Major. Every other snapshot just re-stores the same value.
    mode: state.mode,
    tracks: state.tracks.map(t=>({
      id:t.id, name:t.name, color:t.color, muted:t.muted, solo:t.solo, volume:t.volume, pan:t.pan,
      instrument: Object.assign({}, t.instrument),
      notes: t.notes.map(n=>({...n})),
      regions: t.regions ? t.regions.map(r=>({...r})) : null,
      automation: cloneAutomation(t.automation)
    }))
  };
}
function pushHistory(){
  undoStack.push(snapshotTracks());
  if(undoStack.length>100) undoStack.shift();
  redoStack = [];
}
function beginHistoryGesture(){
  if(!historyArmed){ pushHistory(); historyArmed = true; }
}
function endHistoryGesture(){ historyArmed = false; }
function restoreSnapshot(snap){
  state.selectedTrackId = snap.selectedTrackId;
  // put the mode (and its select, and everything keyed off the scale) back before the notes are laid
  // out again. Older snapshots predate this field, so fall back to leaving the mode where it is.
  if(snap.mode && snap.mode!==state.mode){
    state.mode = snap.mode;
    const ms = document.getElementById("modeSel");
    if(ms) ms.value = state.mode;
    buildPianoLabels(); drawGridLines();
    if(typeof renderChordPalette==="function") renderChordPalette();
  }
  state.tracks = snap.tracks.map(t=>{
    const track = { id:t.id, name:t.name, color:t.color, muted:t.muted, solo:t.solo, volume:t.volume, pan:t.pan??50,
      instrument: Object.assign({}, t.instrument), notes: t.notes.map(n=>({...n})),
      regions: t.regions ? t.regions.map(r=>({...r})) : null,
      automation: t.automation ? cloneAutomation(t.automation) : defaultAutomation() };
    nextTrackId = Math.max(nextTrackId, track.id+1);
    track.notes.forEach(n=>{ nextNoteId = Math.max(nextNoteId, n.id+1); });
    Object.values(track.automation).forEach(pts=> pts.forEach(p=>{ nextNoteId = Math.max(nextNoteId, p.id+1); }));
    // the registry itself is deliberately NOT snapshotted (an upload is an asset, not an edit, so undo
    // must not un-import it) — the snapshot only carries sampleId, and this puts the buffer back
    resolveTrackSample(track);
    buildChain(track);
    return track;
  });
  selectedNoteIds.clear(); selectedRegionIds.clear(); selectedAutoPointIds.clear(); phantomSelection = null;
  renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); buildTrackList(); renderAdvancedEditor();
  recomputeStepsTotal();
}
function undo(){
  if(!undoStack.length){ toast("Nothing to undo"); return; }
  redoStack.push(snapshotTracks());
  restoreSnapshot(undoStack.pop());
  toast("Undo");
}
function redo(){
  if(!redoStack.length){ toast("Nothing to redo"); return; }
  undoStack.push(snapshotTracks());
  restoreSnapshot(redoStack.pop());
  toast("Redo");
}

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

/* ======================================================================
   AUTOMATION LANES -> LIVE AUDIO PARAMETERS
   each lane (Volume/Pan/Reverb/EQ Low/EQ Mid/EQ High) is a set of 0-100 points
   plotted step->value; while a lane has no points drawn, its parameter just
   tracks the track's own knob (see autoDefaultValue), so automation only takes
   over once the user actually draws a curve for it
   ====================================================================== */
function automationValueAt(track, param, step){
  const points = track.automation[param];
  if(!points || points.length===0) return autoDefaultValue(track, param);
  const pts = points.slice().sort((a,b)=>a.step-b.step);
  if(step<=pts[0].step) return pts[0].value;
  if(step>=pts[pts.length-1].step) return pts[pts.length-1].value;
  for(let i=0;i<pts.length-1;i++){
    const a=pts[i], b=pts[i+1];
    if(step>=a.step && step<=b.step){
      const f = (step-a.step)/((b.step-a.step)||1);
      return a.value + (b.value-a.value)*f;
    }
  }
  return pts[pts.length-1].value;
}
// smoothing time constant for setTargetAtTime: short enough to track the drawn curve responsively,
// long enough (paired with the 25ms scheduler tick) to avoid zipper-noise clicks between updates
const AUTOMATION_SMOOTHING = 0.02;
function applyAutomationAtStep(step){
  const solo = anySolo();
  const now = actx.currentTime;
  state.tracks.forEach(track=>{
    if(!track._chain) buildChain(track);
    const c = track._chain;
    const audible = solo ? track.solo : !track.muted;
    const vol = automationValueAt(track,"volume",step)/100;
    const pan = Math.max(-1, Math.min(1, (automationValueAt(track,"pan",step)-50)/50));
    const reverb = automationValueAt(track,"reverb",step)/100;
    const eqLow = automationValueAt(track,"eqLow",step)/100*48-24;
    const eqMid = automationValueAt(track,"eqMid",step)/100*48-24;
    const eqHigh = automationValueAt(track,"eqHigh",step)/100*48-24;
    c.trackOut.gain.setTargetAtTime(audible?vol:0, now, AUTOMATION_SMOOTHING);
    c.panNode.pan.setTargetAtTime(pan, now, AUTOMATION_SMOOTHING);
    c.eqLow.gain.setTargetAtTime(eqLow, now, AUTOMATION_SMOOTHING);
    c.eqMid.gain.setTargetAtTime(eqMid, now, AUTOMATION_SMOOTHING);
    c.eqHigh.gain.setTargetAtTime(eqHigh, now, AUTOMATION_SMOOTHING);
    c.dry.gain.setTargetAtTime(1-reverb*0.6, now, AUTOMATION_SMOOTHING);
    c.wet.gain.setTargetAtTime(reverb, now, AUTOMATION_SMOOTHING);
  });
}
function anySolo(){ return state.tracks.some(t=>t.solo); }
function refreshAllTrackGains(){
  const solo = anySolo();
  state.tracks.forEach(t=>{
    if(!t._chain) buildChain(t);
    const audible = solo ? t.solo : !t.muted;
    t._chain.trackOut.gain.value = audible ? t.volume : 0;
  });
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
let activeVoices = [];
// renderCtx (optional) lets offline WAV export reuse this exact synthesis logic against an
// OfflineAudioContext + its own per-track chain, instead of the live actx/track._chain — every node
// in a graph must belong to the same (Offline)AudioContext as its destination, so live playback and
// export can't share actual nodes, only this function's logic
function playNote(track, midi, startTime, durSec, bendToMidi, bendDelaySec, bendEndSec, renderCtx){
  const ctx = renderCtx ? renderCtx.ctx : actx;
  if(!renderCtx && !track._chain) buildChain(track);
  const chain = renderCtx ? renderCtx.chain : track._chain;
  const inst = track.instrument;
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
  let source;

  if(inst.wave==="custom" && inst.customBuffer){
    const src = ctx.createBufferSource(); src.buffer = inst.customBuffer;
    src.playbackRate.setValueAtTime(Math.pow(2,(midi-inst.customBaseMidi)/12), startTime);
    if(hasBend){
      src.playbackRate.setValueAtTime(Math.pow(2,(midi-inst.customBaseMidi)/12), bendAt);
      src.playbackRate.linearRampToValueAtTime(Math.pow(2,(bendToMidi-inst.customBaseMidi)/12), bendDoneAt);
    }
    src.connect(env); src.start(startTime); src.stop(stopAt);
    source = src;
  } else if(inst.wave==="noise"){
    const src = ctx.createBufferSource(); src.buffer = renderCtx ? renderCtx.noiseBuffer : getNoiseBuffer(); src.loop=true;
    const bp = ctx.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=1.2;
    bp.frequency.setValueAtTime(midiToFreq(midi)*2, startTime);
    if(hasBend){
      bp.frequency.setValueAtTime(midiToFreq(midi)*2, bendAt);
      bp.frequency.linearRampToValueAtTime(midiToFreq(bendToMidi)*2, bendDoneAt);
    }
    src.connect(bp); bp.connect(env);
    src.start(startTime); src.stop(stopAt);
    source = src;
  } else if(inst.wave==="pulse25" || inst.wave==="pulse12"){
    // approximate pulse wave via two detuned sawtooths (poor-man's PWM) -> simpler: use square with custom periodic wave
    const osc = ctx.createOscillator();
    const real = new Float32Array(16), imag = new Float32Array(16);
    const duty = inst.wave==="pulse25"?0.25:0.125;
    for(let n=1;n<16;n++){ real[n]=0; imag[n]=(2/(n*Math.PI))*Math.sin(n*Math.PI*duty); }
    const wave = ctx.createPeriodicWave(real,imag,{disableNormalization:false});
    osc.setPeriodicWave(wave);
    osc.frequency.setValueAtTime(midiToFreq(midi), startTime);
    if(hasBend){
      osc.frequency.setValueAtTime(midiToFreq(midi), bendAt);
      osc.frequency.linearRampToValueAtTime(midiToFreq(bendToMidi), bendDoneAt);
    }
    osc.connect(env); osc.start(startTime); osc.stop(stopAt);
    source = osc;
  } else {
    const osc = ctx.createOscillator();
    osc.type = inst.wave;
    osc.frequency.setValueAtTime(midiToFreq(midi), startTime);
    if(hasBend){
      osc.frequency.setValueAtTime(midiToFreq(midi), bendAt);
      osc.frequency.linearRampToValueAtTime(midiToFreq(bendToMidi), bendDoneAt);
    }
    osc.connect(env); osc.start(startTime); osc.stop(stopAt);
    source = osc;
  }

  if(renderCtx) return; // offline render: no live-voice bookkeeping needed, nothing to silence early
  // opportunistic cleanup of long-finished voices, so this array doesn't grow unbounded over a long session
  activeVoices = activeVoices.filter(v=> v.stopAt > actx.currentTime);
  activeVoices.push({env, source, stopAt});
}

// immediately silences every voice currently sounding — used on pause/stop so notes don't ring out
// past where the transport actually stopped
function silenceAllVoices(){
  const now = actx.currentTime;
  activeVoices.forEach(v=>{
    try{ v.env.gain.cancelScheduledValues(now); v.env.gain.setValueAtTime(0, now); }catch(e){}
    try{ v.source.stop(now); }catch(e){}
  });
  activeVoices = [];
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

/* ======================================================================
   TRANSPORT / SCHEDULER
   ====================================================================== */
let schedulerTimer=null, playCtxStartTime=0, playStepAt0=0;
function stepDurSec(){ return (60/state.bpm) / 4; } // 16th-note step
function currentPlayStep(){
  if(!state.playing) return state.playStartStep;
  const elapsed = actx.currentTime - playCtxStartTime;
  return playStepAt0 + elapsed/stepDurSec();
}
let scheduledUpTo = 0;
let scheduledMetroUpTo = 0;
function startPlayback(){
  if(state.playing) return;
  if(actx.state==="suspended") actx.resume();
  // pressing play with an active loop should always land you inside it, not silently play through
  // from wherever the playhead happens to be sitting outside the loop's bounds
  if(state.loop.enabled && (state.playStartStep<state.loop.start || state.playStartStep>=state.loop.end)){
    state.playStartStep = state.loop.start;
  }
  state.playing = true;
  playCtxStartTime = actx.currentTime;
  playStepAt0 = state.playStartStep;
  scheduledUpTo = playStepAt0;
  scheduledMetroUpTo = playStepAt0;
  document.getElementById("playBtn").innerHTML = "&#10074;&#10074;";
  schedulerTimer = setInterval(schedulerTick, 25);
  schedulerTick();
  requestAnimationFrame(animatePlayhead);
}
function stopPlayback(resetHead){
  // must be read before state.playing flips to false — currentPlayStep() falls back to the
  // (stale) state.playStartStep once playing is false, which was silently discarding the paused
  // position and snapping the playhead back to wherever it last started from
  const pausedAtStep = currentPlayStep();
  state.playing = false;
  clearInterval(schedulerTimer);
  document.getElementById("playBtn").innerHTML = "&#9654;";
  state.playStartStep = resetHead ? 0 : pausedAtStep;
  silenceAllVoices();
  // automation only drives the chain during playback; once stopped, drop each track back to its own knob values
  state.tracks.forEach(applyInstrumentToChain);
  renderPlayheads();
}
// the Play button's own play/pause toggle — whether pausing keeps the playhead where it paused or
// snaps it back to the start is governed by the "Hold" button (off by default: snaps back)
function togglePlayPause(){
  if(state.playing) stopPlayback(!state.holdPositionOnPause);
  else startPlayback();
}
function schedulerTick(){
  const lookahead = 0.12; // seconds
  let nowStep = currentPlayStep();
  if(state.loop.enabled && nowStep >= state.loop.end){
    playCtxStartTime = actx.currentTime;
    playStepAt0 = state.loop.start;
    scheduledUpTo = playStepAt0;
    scheduledMetroUpTo = playStepAt0;
    nowStep = playStepAt0;
  }
  applyAutomationAtStep(nowStep);
  const horizon = nowStep + lookahead/stepDurSec();
  if(state.metronomeOn){
    const spb = stepsPerBar();
    const beatStep = spb/beatsPerBar();
    let s = Math.ceil(scheduledMetroUpTo/beatStep)*beatStep;
    for(; s < horizon; s += beatStep){
      const t = playCtxStartTime + (s - playStepAt0)*stepDurSec();
      if(t >= actx.currentTime-0.01){
        // s is always a multiple of beatStep measured from absolute step 0, so this lines up with the
        // same bar grid the ruler/arrange view uses regardless of where playback happened to start
        playClick(t, Math.round(s) % spb === 0);
      }
    }
    scheduledMetroUpTo = horizon;
  }
  state.tracks.forEach(track=>{
    const solo = anySolo();
    const audible = solo ? track.solo : !track.muted;
    if(!audible) return;
    track.notes.forEach(note=>{
      if(note.step >= scheduledUpTo && note.step < horizon){
        const t = playCtxStartTime + (note.step - playStepAt0)*stepDurSec();
        if(t >= actx.currentTime-0.01){
          playNote(track, note.pitch, t, note.dur*stepDurSec()*0.92, note.bendTo, clampedBendStartStep(note)*stepDurSec(), clampedBendEndStep(note)*stepDurSec());
        }
      }
    });
  });
  scheduledUpTo = horizon;
  if(!state.loop.enabled && nowStep > STEPS_TOTAL) stopPlayback(true);
}
function animatePlayhead(){
  if(!state.playing) return;
  renderPlayheads();
  requestAnimationFrame(animatePlayhead);
}
function renderPlayheads(){
  const step = currentPlayStep();
  const x = step*STEP_W;
  document.getElementById("playhead").style.left = x+"px";
  // the grip is a sticky sibling (not JS-positioned vertically — see its CSS), so it only needs its
  // horizontal offset kept in sync with the playhead line; its "stuck" vertical tracking of the ruler
  // is handled natively by the browser's compositor, with zero lag versus a scroll-event handler.
  // Positioned via transform, not left: a sticky element sticks whichever axis has a non-auto inset,
  // so setting `left` here would also freeze the grip horizontally once the grid scrolled underneath it.
  document.getElementById("playheadGrip").style.transform = "translateX("+x+"px)";
  const trackX = step/stepsPerBar()*BAR_PX;
  document.getElementById("trackListPlayhead").style.left = trackX+"px";
  positionTrackListFlag();
  // Follow the playhead only while it is actually moving under playback's control. When stopped, the
  // two scrollers belong entirely to the user — renderPlayheads() also runs on zoom, undo, edits and
  // manual playhead drags, and yanking the view on any of those would be hostile.
  if(state.playing){
    centerScrollOnPlayhead(gridScroll, x);
    centerScrollOnPlayhead(document.getElementById("trackListCol"), trackX);
  }
}
// Parks `x` (a content-space pixel offset) in the middle of the scroller's viewport, clamped to the
// real scroll range so the very start and very end of the project simply sit off-center instead of
// being forced past the ends. scrollLeft ONLY: the arrange view mirrors scrollTop between
// #instrumentListScroll and #trackListCol, so touching the vertical axis here would fight that sync.
// Writing scrollLeft does fire each element's "scroll" listener, but neither one reads scrollLeft
// (syncPianoScroll only mirrors scrollTop to the piano column), so there is no feedback loop.
function centerScrollOnPlayhead(el, x){
  if(!el) return;
  const max = el.scrollWidth - el.clientWidth;
  if(max <= 0) return; // content fits: nothing to scroll, and scrollLeft would just clamp to 0 anyway
  el.scrollLeft = Math.max(0, Math.min(max, x - el.clientWidth/2));
}

// keeps the little playhead flag pinned to whatever row is currently scrolled to the top of the
// arrange view (like the ruler), instead of staying anchored to the top of the full scrollable content
function positionTrackListFlag(){
  const flag = document.getElementById("trackListPlayheadFlag");
  const tc = document.getElementById("trackListCol");
  if(!flag || !tc) return;
  const step = currentPlayStep();
  flag.style.left = (step/stepsPerBar()*BAR_PX - 6) + "px";
  flag.style.top = tc.scrollTop + "px";
}

/* ======================================================================
   LOOP REGION
   ====================================================================== */
function renderLoopUI(){
  const region = document.getElementById("loopRegion");
  if(!region) return;
  const spb = stepsPerBar();
  region.style.display = "block";
  region.style.left = (state.loop.start/spb*BAR_PX)+"px";
  region.style.width = Math.max(4,(state.loop.end-state.loop.start)/spb*BAR_PX)+"px";
  region.classList.toggle("enabled", state.loop.enabled);
}

/* ======================================================================
   UI BUILD: HEADER SELECTS
   ====================================================================== */
const keySel = document.getElementById("keySel");
NOTE_NAMES.forEach(n=>{ const o=document.createElement("option"); o.value=n; o.textContent=n; keySel.appendChild(o); });
const octaveSel = document.getElementById("octaveSel");
for(let o=OCT_MIN;o<=OCT_MAX;o++){ const opt=document.createElement("option"); opt.value=o; opt.textContent="Octave "+o+(o===4?" (default)":""); octaveSel.appendChild(opt); }
octaveSel.value=4;

/* ======================================================================
   PIANO ROLL: ROW LABELS
   ====================================================================== */
const TOTAL_ROWS = (OCT_MAX-OCT_MIN+1)*12; // full chromatic range
const TOP_MIDI = (OCT_MAX+2)*12-1; // highest midi shown at row 0
function rowToMidi(row){ return TOP_MIDI-row; }
function midiToRow(midi){ return TOP_MIDI-midi; }

function scaleSemitones(){ return SCALES[state.mode] || SCALES.Major; }
function isInScale(midi){
  const keyIdx = NOTE_NAMES.indexOf(state.key);
  const rel = ((midi - keyIdx)%12+12)%12;
  return scaleSemitones().includes(rel);
}

/* ---------- MODE SWITCHING: transposition by scale degree ----------
   Changing the project's mode is meant to move the MUSIC into the new mode, not just recolour which
   rows count as in-scale. A note is therefore remapped by WHICH DEGREE OF THE SCALE it is, keeping its
   position in the run and taking the new mode's semitone for that position: C D E F G A B C in C Major
   becomes C D D# F G G# A# C in C Minor, because degree 2 sits 4 semitones above the root in Major and
   3 in Minor, degree 5 at 9 vs 8, degree 6 at 11 vs 10.

   Deliberately NOT nearest-pitch snapping. Every one of the twelve pitches is a real pitch, so a "snap
   to the closest legal note" rule would leave E, A and B exactly where they are and the switch would
   change nothing at all — the thirds, sixths and sevenths that actually define a mode are precisely the
   notes that must move. */
function transposePitchBetweenModes(pitch, keyIdx, fromScale, toScale){
  // Chromatic is the one scale with 12 entries, and its positions carry no degree identity — index 11
  // of a 12-entry list is not "the seventh" of anything. Arriving at Chromatic is therefore a no-op:
  // every pitch already belongs to it, so nothing needs to move.
  if(toScale.length===12) return pitch;
  // `rel` is the note's position inside its own key-relative octave and `base` carries everything else
  // (the octave AND the key offset), so rebuilding the pitch as base+newRel keeps each note in the very
  // same octave it started in instead of letting it drift up or down one.
  const rel = ((pitch - keyIdx)%12+12)%12;
  let base = pitch - rel;
  let out;
  if(fromScale.length===12){
    // Leaving Chromatic is the mirror problem: there are 12 source positions and only 7 target degrees,
    // so index mapping would scatter the notes over more than an octave. Snap to the nearest pitch of
    // the target scale instead. Only candidates within this same key-relative octave are considered and
    // ties go to the LOWER one, so a snap can never bump a note into a neighbouring octave.
    let best = toScale[0];
    for(let i=1;i<toScale.length;i++){ if(Math.abs(toScale[i]-rel) < Math.abs(best-rel)) best = toScale[i]; }
    out = base + best;
  } else {
    const idx = fromScale.indexOf(rel);
    if(idx!==-1){
      // the common case, and the one the user's example is about: both scales have exactly 7 degrees,
      // so degree N of the old mode is unambiguously degree N of the new one.
      out = base + toScale[idx];
    } else {
      // An accidental has no degree of its own, so it borrows one: anchor it to the nearest degree AT
      // OR BELOW it and carry its chromatic offset across unchanged. Chosen over rounding to the
      // nearest degree because it keeps a chromatic passing tone sitting just above the same scale
      // tone it was leaning on before the switch. Degree 0 is always semitone 0, so an anchor always
      // exists for any rel that is not itself a degree.
      let anchor = 0;
      for(let i=0;i<fromScale.length;i++){ if(fromScale[i] < rel) anchor = i; }
      let newRel = toScale[anchor] + (rel - fromScale[anchor]);
      // re-normalise: an offset carried onto a degree that sits higher in the new mode can push past
      // the top of the octave, in which case it folds into `base` rather than being left out of range
      if(newRel > 11){ newRel -= 12; base += 12; }
      out = base + newRel;
    }
  }
  // that fold (and a downward snap out of Chromatic in a non-C key) is the only way this can leave the
  // pitch range the grid can actually draw, so clamp it the same way importMidiTracks does
  return Math.max(TOP_MIDI-TOTAL_ROWS+1, Math.min(TOP_MIDI, out));
}
// Sweeps every note of every track — mode is a PROJECT setting, so the switch applies to the whole
// project, not just the selected track. Returns how many NOTES were touched (a note whose slur target
// moved counts once, like the single tile it draws as), so the caller can tell a switch worth an undo
// checkpoint from one that changed nothing (Major→Lydian only ever touches degree 3, so a part that
// never plays it comes out identical).
function transposeProjectToMode(fromMode, toMode){
  const fromScale = SCALES[fromMode] || SCALES.Major;
  const toScale = SCALES[toMode] || SCALES.Major;
  const keyIdx = Math.max(0, NOTE_NAMES.indexOf(state.key));
  let moved = 0;
  state.tracks.forEach(track=>{
    track.notes.forEach(n=>{
      let touched = false;
      const p = transposePitchBetweenModes(n.pitch, keyIdx, fromScale, toScale);
      if(p!==n.pitch){ n.pitch = p; touched = true; }
      // a slur target is a real pitch drawn on the grid (renderNotes places the stub at
      // midiToRow(bendTo)), so it has to travel by the same rule — otherwise the note would land in the
      // new mode while the pitch it slides into stayed behind in the old one
      if(n.bendTo!=null){
        const b = transposePitchBetweenModes(n.bendTo, keyIdx, fromScale, toScale);
        if(b!==n.bendTo){ n.bendTo = b; touched = true; }
      }
      if(touched) moved++;
    });
  });
  return moved;
}

function buildPianoLabels(){
  const inner = document.getElementById("pianoColInner");
  inner.style.height = (TOTAL_ROWS*ROW_H)+"px";
  inner.innerHTML="";
  for(let row=0; row<TOTAL_ROWS; row++){
    const midi = rowToMidi(row);
    const name = NOTE_NAMES[((midi%12)+12)%12];
    const oct = Math.floor(midi/12)-1;
    const div = document.createElement("div");
    div.className="pianoRowLabel"+(name==="C"?" c-row":"")+(isInScale(midi)?" in-scale":"");
    div.style.top=(row*ROW_H)+"px"; div.style.height=ROW_H+"px";
    div.textContent = name==="C" ? ("C"+oct) : name.replace("#","♯");
    div.dataset.midi = midi;
    const isNatural = name.indexOf("#")===-1;
    // C3 gets its own lighter tint so it reads as a landmark row instead of blending into every other C
    div.style.background = (name==="C" && oct===3) ? "var(--row-c3)" : (name==="C" ? "var(--row-c)" : (isNatural ? "var(--row-light)" : "var(--row-dark)"));
    inner.appendChild(div);
  }
}

/* ======================================================================
   PIANO ROLL: GRID CANVAS + NOTES
   ====================================================================== */
const gridScroll = document.getElementById("gridScroll");
const gridInner = document.getElementById("gridInner");
const gridCanvas = document.getElementById("gridCanvas");
const noteLayer = document.getElementById("noteLayer");
const pianoCol = document.getElementById("pianoCol");

function stepsPerBeat(){ return 4; } // grid resolution fixed at 16th notes
function beatsPerBar(){ return state.timeSig[0]; }
function stepsPerBar(){ return beatsPerBar()*stepsPerBeat()*(4/state.timeSig[1]); }

function sizeGrid(){
  const w = STEPS_TOTAL*STEP_W, h = TOTAL_ROWS*ROW_H;
  // gridInner reserves real space for the ruler (GRID_RULER_H) on top of the row content — the canvas
  // and note layer themselves stay sized to just the rows (h) and are pushed down via their own CSS
  // top offset, so nothing here needs to know about the ruler except the container's total height
  gridInner.style.width=w+"px"; gridInner.style.height=(h+GRID_RULER_H)+"px";
  gridCanvas.width=w; gridCanvas.height=h; gridCanvas.style.width=w+"px"; gridCanvas.style.height=h+"px";
  noteLayer.style.width=w+"px"; noteLayer.style.height=h+"px";
  drawGridLines();
  drawGridRuler();
}

// bar-number ruler pinned atop the piano roll grid itself — same idea as the arrange view's ruler,
// but scaled to STEP_W (which changes with zoom) instead of the arrange view's fixed BAR_PX, since it
// shares the note grid's own horizontal coordinate space
function drawGridRuler(){
  const ruler = document.getElementById("gridRuler");
  if(!ruler) return;
  const totalW = STEPS_TOTAL*STEP_W;
  const h = 18, dpr = window.devicePixelRatio||1;
  const canvas = document.createElement("canvas");
  canvas.width = totalW*dpr; canvas.height = h*dpr;
  canvas.style.width = totalW+"px"; canvas.style.height = h+"px";
  ruler.innerHTML = ""; ruler.appendChild(canvas);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,totalW,h);
  const spb = stepsPerBar(), beats = beatsPerBar(), barPx = spb*STEP_W;
  const totalBars = Math.ceil(STEPS_TOTAL/spb);
  ctx.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
  ctx.textBaseline = "top";
  for(let bar=0; bar<totalBars; bar++){
    const x = bar*barPx;
    ctx.strokeStyle = "#5a5a68"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+.5, 0); ctx.lineTo(x+.5, h); ctx.stroke();
    ctx.fillStyle = "#b7b7c2";
    ctx.fillText(String(bar+1), x+4, 2);
    ctx.strokeStyle = "#3a3a44";
    for(let b=1; b<beats; b++){
      const bx = x + b*(barPx/beats);
      ctx.beginPath(); ctx.moveTo(bx+.5, h*0.6); ctx.lineTo(bx+.5, h); ctx.stroke();
    }
  }
}

// grow the timeline (grid + ruler) to keep some empty room past whatever the furthest note/track content reaches —
// never shrinks back on its own, so the ruler/grid never "run out" as parts extend beyond the original 16 bars
// if a track has been split into regions, make sure a newly-added note always falls inside one —
// growing the nearest region to cover it rather than leaving the note invisible in the track list
function extendRegionsForNote(track, note){
  if(!track.regions || !track.regions.length) return;
  if(track.regions.some(r=> note.step>=r.start && note.step<r.end)) return;
  let nearest = track.regions[0], nearestDist = Infinity;
  track.regions.forEach(r=>{
    const mid = (r.start+r.end)/2, dist = Math.abs(note.step-mid);
    if(dist<nearestDist){ nearestDist=dist; nearest=r; }
  });
  if(note.step < nearest.start) nearest.start = note.step;
  if(note.step+note.dur > nearest.end) nearest.end = note.step+note.dur;
}

function recomputeStepsTotal(){
  let maxEnd = STEPS_TOTAL_BASE;
  state.tracks.forEach(t=> t.notes.forEach(n=>{ maxEnd = Math.max(maxEnd, n.step+n.dur); }));
  const spb = stepsPerBar();
  const needed = Math.ceil(maxEnd/spb)*spb + spb*4;
  if(needed > STEPS_TOTAL){
    STEPS_TOTAL = needed;
    sizeGrid();
    buildTrackList();
  }
}

// zoom the tile grid horizontally (trackpad pinch or the zoom slider), keeping the view centered on the same step
function setZoom(newStepW){
  newStepW = Math.max(STEP_W_MIN, Math.min(STEP_W_MAX, Math.round(newStepW)));
  if(newStepW===STEP_W) return;
  const centerStep = (gridScroll.scrollLeft + gridScroll.clientWidth/2)/STEP_W;
  STEP_W = newStepW;
  sizeGrid();
  renderNotes();
  renderPlayheads();
  gridScroll.scrollLeft = Math.max(0, centerStep*STEP_W - gridScroll.clientWidth/2);
  const zs = document.getElementById("zoomSlider");
  if(zs) zs.value = STEP_W;
}
function drawGridLines(){
  const ctx = gridCanvas.getContext("2d");
  const w=gridCanvas.width, h=gridCanvas.height;
  ctx.clearRect(0,0,w,h);
  // row backgrounds: alternate light gray (natural notes) / dark gray (sharps)
  for(let row=0; row<TOTAL_ROWS; row++){
    const midi = rowToMidi(row);
    const name = NOTE_NAMES[((midi%12)+12)%12];
    const oct = Math.floor(midi/12)-1;
    const isNatural = name.indexOf("#")===-1;
    ctx.fillStyle = (name==="C" && oct===3) ? "#34343e" : (name==="C" ? "rgba(111,168,255,.18)" : (isNatural ? "#2c2c34" : "#1c1c22"));
    ctx.fillRect(0,row*ROW_H,w,ROW_H);
  }
  // horizontal separators
  ctx.strokeStyle="#000000"; ctx.lineWidth=1;
  for(let row=0; row<=TOTAL_ROWS; row++){
    ctx.beginPath(); ctx.moveTo(0,row*ROW_H+.5); ctx.lineTo(w,row*ROW_H+.5); ctx.stroke();
  }
  // vertical step/beat/bar lines
  const spb = stepsPerBar(), spBeat = stepsPerBeat();
  for(let s=0;s<=STEPS_TOTAL;s++){
    const isBar = s%spb===0, isBeat = s%spBeat===0;
    ctx.strokeStyle = isBar? "#5a5a68" : (isBeat? "#3a3a44" : "#26262e");
    ctx.lineWidth = isBar?1.4:1;
    ctx.beginPath(); ctx.moveTo(s*STEP_W+.5,0); ctx.lineTo(s*STEP_W+.5,h); ctx.stroke();
  }
}

function selectedTrack(){ return state.tracks.find(t=>t.id===state.selectedTrackId); }

// clamps a slurred note's bend-start offset (in steps, relative to note.step) to stay within the tile —
// leaves a small sliver at the end so the slide is never squashed down to nothing
function clampedBendStartStep(note){
  const max = Math.max(0, note.dur-0.15);
  return Math.max(0, Math.min(max, note.bendStartStep||0));
}
// clamps where the slide finishes (in steps, relative to note.step) — must land after the start point
// and never past the note's own end; defaults to the note's end (the slide fills the whole tail, same
// as the original always-ramps-to-the-last-instant behavior)
function clampedBendEndStep(note){
  const min = clampedBendStartStep(note)+0.15;
  const max = note.dur;
  const raw = note.bendEndStep==null ? note.dur : note.bendEndStep;
  return Math.max(min, Math.min(max, raw));
}

// The Note Length dropdown doubles as a property editor for the selection (see its change handler), so
// it has to READ as one too: with notes selected it shows their length, and with nothing selected it
// falls back to the length the next placed note will get. Driven from renderNotes() because that is
// what every selection change already goes through.
function syncNoteLenSelToSelection(){
  const sel = document.getElementById("noteLenSel"); if(!sel) return;
  const track = selectedTrack();
  if(track && selectedNoteIds.size){
    const durs = track.notes.filter(n=>selectedNoteIds.has(n.id)).map(n=>n.dur);
    if(!durs.length) return;
    // mixed lengths — or a dragged-out length like 3 steps that no option represents — leave the
    // dropdown exactly as it is, rather than blanking it out with a value it has no <option> for
    if(durs.every(d=>d===durs[0]) && Array.prototype.some.call(sel.options, o=>Number(o.value)===durs[0])){
      sel.value = String(durs[0]);
    }
    return;
  }
  sel.value = String(state.noteLenSteps);
}

function renderNotes(){
  noteLayer.innerHTML="";
  selectedNoteIds.forEach(id=>{ if(!selectedTrack() || !selectedTrack().notes.some(n=>n.id===id)) selectedNoteIds.delete(id); });
  syncNoteLenSelToSelection();
  const track = selectedTrack();
  if(!track) return;
  track.notes.forEach(note=>{
    const row = midiToRow(note.pitch);
    const hasBend = note.bendTo!=null && note.bendTo!==note.pitch;
    const div = document.createElement("div");
    div.className = "note"+(selectedNoteIds.has(note.id)?" selected":"")+(hasBend?" bend":"");
    div.style.left=(note.step*STEP_W+1)+"px";
    div.style.top=(row*ROW_H+1)+"px";
    div.style.width=(note.dur*STEP_W-2)+"px";
    div.style.height=(ROW_H-2)+"px";
    div.style.background = hasBend
      ? "linear-gradient(to right, "+track.color+", var(--accent2))"
      : track.color;
    div.dataset.id = note.id;
    div.title = hasBend ? "Slurred: "+midiToName(note.pitch)+" → "+midiToName(note.bendTo) : midiToName(note.pitch);
    const leftGrip = document.createElement("div");
    leftGrip.className = "leftHandle";
    leftGrip.title = "Drag to trim the start of the note";
    div.appendChild(leftGrip);
    const grip = document.createElement("div");
    grip.className = "bendHandle";
    grip.title = "Drag sideways to resize, up/down to slur/tie into another pitch";
    div.appendChild(grip);
    noteLayer.appendChild(div);

    if(hasBend){
      const destRow = midiToRow(note.bendTo);
      // the stub stays a fixed one-16th-note cell — it doesn't stretch, it just translates left/right
      // across the tile, and wherever it lands marks the point where the slide finishes (bendEndStep)
      const bendEndStep = clampedBendEndStep(note);
      const stubW = STEP_W-2;
      const stubRightRaw = note.step*STEP_W + bendEndStep*STEP_W + 1;
      const stubLeft = Math.max(note.step*STEP_W+1, stubRightRaw-stubW);
      const stub = document.createElement("div");
      stub.className = "bendStub";
      stub.dataset.id = note.id;
      stub.title = "Drag sideways to change where the slide ends, up/down to change the slur target";
      stub.style.left = stubLeft+"px";
      stub.style.width = stubW+"px";
      stub.style.top = (destRow*ROW_H + 1)+"px";
      stub.style.height = (ROW_H-2)+"px";
      stub.style.background = "var(--accent2)";
      noteLayer.appendChild(stub);

      // the slide is drawn from the bend-start point (defaulting to the note's own left edge) rather than
      // always the note's start, so the slur can begin partway through the note. Its drag handle sits at
      // the top of the tile rather than at the row's vertical center — right on top of the row-center is
      // exactly where the leftHandle resize grip lives, so the dot used to win that hit-test and made it
      // hard to grab the resize handle near a slurred note's left edge
      const bendStartStep = clampedBendStartStep(note);
      const startDot = document.createElement("div");
      startDot.className = "bendStartHandle";
      startDot.dataset.id = note.id;
      startDot.title = "Drag to change where the slur begins";
      startDot.style.left = (note.step*STEP_W + bendStartStep*STEP_W + 1)+"px";
      startDot.style.top = (row*ROW_H + 5)+"px";
      noteLayer.appendChild(startDot);

      const svgNS = "http://www.w3.org/2000/svg";
      const x1 = note.step*STEP_W + bendStartStep*STEP_W + 1, y1 = row*ROW_H+ROW_H/2;
      const x2 = note.step*STEP_W + bendEndStep*STEP_W + 1, y2 = destRow*ROW_H+ROW_H/2;
      const left = Math.min(x1,x2), top = Math.min(y1,y2);
      const w = Math.max(1,Math.abs(x2-x1)), h = Math.max(1,Math.abs(y2-y1));
      const svg = document.createElementNS(svgNS,"svg");
      svg.setAttribute("class","bendSlide");
      svg.style.left=left+"px"; svg.style.top=top+"px"; svg.style.width=w+"px"; svg.style.height=h+"px";
      svg.setAttribute("viewBox", "0 0 "+w+" "+h);
      const path = document.createElementNS(svgNS,"path");
      const lx1=x1-left, ly1=y1-top, lx2=x2-left, ly2=y2-top;
      path.setAttribute("d", "M"+lx1+","+ly1+" Q"+((lx1+lx2)/2)+","+ly2+" "+lx2+","+ly2);
      path.setAttribute("stroke","var(--accent2)");
      path.setAttribute("stroke-width","2");
      path.setAttribute("fill","none");
      path.setAttribute("stroke-linecap","round");
      svg.appendChild(path);
      noteLayer.appendChild(svg);
    }
  });

  if(phantomSelection){
    const pdiv = document.createElement("div");
    pdiv.id = "phantomCell";
    pdiv.style.left = (phantomSelection.step*STEP_W+1)+"px";
    pdiv.style.top = (phantomSelection.row*ROW_H+1)+"px";
    // the ghost spans the current Note Length, matching the duration a plain click would place
    pdiv.style.width = (state.noteLenSteps*STEP_W-2)+"px";
    pdiv.style.height = (ROW_H-2)+"px";
    noteLayer.appendChild(pdiv);
  }

  // keep the advanced editor's ghost note tiles live instead of only refreshing on open/close —
  // cheap enough (small canvas) to just redraw every time the piano roll's notes change
  if(state.advancedTrackId!=null) renderAdvancedEditor();
}

/* ======================================================================
   INSTRUMENT LIST (left panel) + TRACK LIST (right panel)
   ====================================================================== */
let BAR_PX = 60; // track-list horizontal zoom — pixels per bar (independent of vertical row shrink)
let TRACK_ROW_H = 46; // shared instrument-row / track-row height — independent of BAR_PX (vertical vs horizontal zoom)
const TRACK_ROW_MIN = 34, TRACK_ROW_MAX = 90;
// Row shrink is a single threshold on the row's height:
//   H >  TRACK_ROW_COMPACT_MAX : full card — name header with the controls row beneath it
//   H <= TRACK_ROW_COMPACT_MAX : single line — controls move to the RIGHT of the name (never hidden);
//                                the name truncates and the waveform select abbreviates to make room
// Instrument rows carry no note preview at any height — the note pattern lives only in the track
// list's own preview blocks (renderTrackBlock) and the advanced editor's lane.
const TRACK_ROW_COMPACT_MAX = 45;
const TRACK_ROW_HDR_H = 22; // instrument-row name strip's height on full-size rows
// track-preview blocks: inset from their row's top/bottom, with an opaque colored header strip
// (mirroring #advLaneHeader) over a translucent body
const TRACK_BLOCK_INSET = 3;
const TRACK_BLOCK_HDR_H = 14;
const BAR_PX_MIN = 20, BAR_PX_MAX = 200;
function refreshArrangeGridBg(){
  document.querySelectorAll(".trackRow").forEach(r=> r.style.setProperty("--barpx", BAR_PX+"px"));
}
function setTrackRowHeight(h){
  TRACK_ROW_H = Math.max(TRACK_ROW_MIN, Math.min(TRACK_ROW_MAX, Math.round(h)));
  renderInstrumentList();
}
// zoom the track list horizontally — the arrange-view counterpart of setZoom(), driven by either the
// #trackZoomSlider or the same ctrl+wheel / trackpad-pinch gesture the piano roll uses
function setTrackZoom(px){
  const next = Math.max(BAR_PX_MIN, Math.min(BAR_PX_MAX, Math.round(px)));
  // a pinch gesture fires dozens of wheel events per second, most of which round to the same integer —
  // bailing here keeps those from each rebuilding the whole track list for no visible change
  if(next===BAR_PX) return;
  BAR_PX = next;
  buildTrackList();
  // the automation lane is measured in BAR_PX too (its width, its curve and its draggable dots all come
  // off stepToX), so it has to be redrawn with the track list or it keeps painting the previous zoom
  // until something else happens to refresh it. Cheap when closed — renderAdvancedEditor bails at once.
  renderAdvancedEditor();
  // keep the slider showing the zoom the wheel gesture just landed on, mirroring setZoom/#zoomSlider
  const ts = document.getElementById("trackZoomSlider");
  if(ts) ts.value = BAR_PX;
}

// translucent variant of a track color for the row body (the opaque header keeps the raw color)
function colorWithAlpha(color, a){
  if(typeof color==="string" && /^#?[0-9a-f]{6}$/i.test(color)){
    const [r,g,b] = hexToRgb(color);
    return "rgba("+r+","+g+","+b+","+a+")";
  }
  return color; // non-hex (named/rgb) colors: fall back to the raw value rather than mangling it
}

function renderInstrumentList(){
  const list = document.getElementById("instrumentList");
  // this function rebuilds the list's DOM from scratch, which resets its scroll container to the top —
  // stash and restore the scroll offset so unrelated rerenders (mute/solo/rename/volume) don't yank
  // the user back to the first instrument. selectTrack() overrides this with a centering scroll.
  const scroller = document.getElementById("instrumentListScroll");
  const keepScrollTop = scroller ? scroller.scrollTop : 0;
  list.innerHTML="";
  const oneline = TRACK_ROW_H<=TRACK_ROW_COMPACT_MAX;
  const hdrH = oneline ? TRACK_ROW_H-1 : TRACK_ROW_HDR_H;
  state.tracks.forEach(track=>{
    const row = document.createElement("div");
    row.className="instrumentRow"+(track.id===state.selectedTrackId?" selected":"")+(oneline?" oneline":"");
    row.dataset.id = track.id;
    row.style.height = TRACK_ROW_H+"px";
    row.style.setProperty("--hdrh", hdrH+"px");
    // the name is plain text until double-clicked (see the dblclick handler on #instrumentList),
    // which swaps in a bordered <input> for the duration of the edit
    row.innerHTML = `
      <div class="tname"><span class="swatch" style="background:${track.color}"></span>
        <span class="nameText" data-role="nameText" title="Double-click to rename">${escapeHtml(track.name)}</span></div>
      <div class="tctrls">
        <button class="mutebtn ${track.muted?'on':''}" data-role="mute">M</button>
        <button class="solobtn ${track.solo?'on':''}" data-role="solo">S</button>
        <select data-role="wave">
          <option value="square">Square</option><option value="pulse25">Pulse25</option>
          <option value="pulse12">Pulse12</option><option value="triangle">Triangle</option>
          <option value="sawtooth">Saw</option><option value="sine">Sine</option>
          <option value="noise">Noise</option>
        </select>
        <input type="range" data-role="vol" min="0" max="100" value="${Math.round(track.volume*100)}">
      </div>`;
    // the sample options are appended (and the value set) here rather than baked into the template
    // string above, because they are project state, not markup — see syncWaveCustomOptions
    syncWaveCustomOptions(row.querySelector('[data-role=wave]'), track.instrument, "Custom");
    list.appendChild(row);
  });
  // second pass, after the rows are in the document and have a measurable layout
  list.querySelectorAll(".instrumentRow").forEach(row=>{
    sizeNameInput(row.querySelector('[data-role=nameText], input[data-role=name]'));
    fitRowControls(row);
  });
  if(scroller) scroller.scrollTop = keepScrollTop;
  buildTrackList();
}
// scrolls the instrument list so the selected row sits in the middle of the visible area, clamped to
// the real scroll range (so the first/last rows just sit at the top/bottom rather than being forced
// past the ends). Called after the list has been rebuilt, since rebuilding resets scrollTop.
function centerSelectedInstrumentRow(opts){
  const scroller = document.getElementById("instrumentListScroll");
  if(!scroller || state.selectedTrackId==null) return;
  const row = scroller.querySelector('.instrumentRow[data-id="'+state.selectedTrackId+'"]');
  if(!row) return;
  if(opts && opts.onlyIfOffscreen){
    const r = row.getBoundingClientRect(), v = scroller.getBoundingClientRect();
    // the sticky header spacer covers the top of the viewport, so "visible" starts below it
    const spacerH = (document.getElementById("instrumentListHeaderSpacer")||{offsetHeight:0}).offsetHeight;
    if(r.top >= v.top+spacerH-0.5 && r.bottom <= v.bottom+0.5) return;
  }
  // measured rather than derived from offsetTop: neither #instrumentListScroll nor #instrumentList is
  // a positioned element, so offsetParent would be the body and offsetTop would be page-relative
  const rowRect = row.getBoundingClientRect(), viewRect = scroller.getBoundingClientRect();
  const rowTopInContent = rowRect.top - viewRect.top + scroller.scrollTop;
  const target = rowTopInContent - (scroller.clientHeight - rowRect.height)/2;
  scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, target));
}
function escapeHtml(s){ const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }

/* ---------- name box sizes itself to its text (no wide empty click strip) ---------- */
let _measureCtx = null;
function measureTextPx(text, font){
  if(!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}
// works for both states of the name box: the plain <span> shown normally and the <input> swapped in
// while it's being edited (see beginNameEdit) — both need the same measured, text-hugging width
function sizeNameInput(el){
  if(!el) return;
  const cs = getComputedStyle(el);
  const text = (el.tagName==="INPUT" ? el.value : el.textContent) || " ";
  const w = measureTextPx(text, cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily);
  const pad = (parseFloat(cs.paddingLeft)||0) + (parseFloat(cs.paddingRight)||0)
            + (parseFloat(cs.borderLeftWidth)||0) + (parseFloat(cs.borderRightWidth)||0);
  const natural = Math.max(10, Math.ceil(w+pad)+3);
  // max-width:100% + flex-shrink still let this give up space to the controls when the row is tight,
  // so the *rendered* width is not a usable measurement — stash the unsqueezed one for fitRowControls
  el.dataset.natw = String(natural);
  if(el.tagName==="INPUT") el.style.width = natural+"px";
}

/* ---------- waveform <select>: the "custom" end of the option list ----------
   Once the project has uploads, the single generic "Custom" entry is replaced by ONE OPTION PER SAMPLE,
   labelled with that sample's name — so choosing an instrument and choosing which sample are the same
   gesture. Values are "custom:<id>", which can't collide with the seven fixed wave values nor with the
   bare "custom" that still means "this instrument is a sample" when no registry entry backs it.

   Labels are fitted to the select's own rendered width and then written into option.dataset.full. That
   is the handshake with applyWaveTier() below: it treats data-full as an option's TRUE label, so tier 0
   restores this already-shortened name (not the raw filename, which would overflow the row) and tier 1
   takes its first letter. */
const WAVE_SEL_ARROW_PX = 20; // room the native dropdown arrow claims beside an option's text
function fitSampleLabel(name, sel){
  const cs = getComputedStyle(sel);
  const font = cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily;
  const budget = (sel.clientWidth||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0)
               - WAVE_SEL_ARROW_PX;
  if(budget<=0 || measureTextPx(name, font)<=budget) return name;
  // drop characters until the name PLUS its ellipsis fits — the "…" is part of what has to fit, so it
  // is measured with the candidate rather than tacked on after the budget was already spent
  let cut = name.length;
  while(cut>1 && measureTextPx(name.slice(0,cut)+"…", font) > budget) cut--;
  return name.slice(0,cut)+"…";
}
function refreshWaveSampleLabels(sel){
  if(!sel) return;
  // measure against the select's UNABBREVIATED width: applyWaveTier's narrow tiers squeeze the box down
  // to 34/22px, and fitting names to that would bake a temporary squeeze into the stored labels
  sel.classList.remove("wtier1","wtier2");
  Array.prototype.forEach.call(sel.options, o=>{
    const s = findSample(Number(o.dataset.sample));
    if(!s) return; // fixed waves and the generic "custom" fallback keep their authored labels
    const label = fitSampleLabel(s.name, sel);
    o.dataset.full = label;
    o.textContent = label;
  });
}
function waveSelValue(inst){
  if(inst.wave!=="custom") return inst.wave;
  return findSample(inst.sampleId) ? "custom:"+inst.sampleId : "custom";
}
function syncWaveCustomOptions(sel, inst, genericLabel){
  if(!sel) return;
  Array.prototype.slice.call(sel.querySelectorAll("option[data-sample]")).forEach(o=>o.remove());
  const resolved = inst ? findSample(inst.sampleId) : null;
  // the plain option survives exactly two cases: a project with no uploads at all (so a fresh project
  // reads exactly as it always did), and a track whose wave is "custom" with nothing in the registry
  // behind it — save files carry no audio data, so a reloaded project lands there, and without this
  // fallback its select would render blank
  if(!state.samples.length || (inst && inst.wave==="custom" && !resolved)){
    const o = document.createElement("option");
    o.value = "custom"; o.textContent = genericLabel; o.dataset.sample = "generic";
    sel.appendChild(o);
  }
  state.samples.forEach(s=>{
    const o = document.createElement("option");
    o.value = "custom:"+s.id; o.dataset.sample = String(s.id); o.textContent = s.name;
    sel.appendChild(o);
  });
  refreshWaveSampleLabels(sel);
  if(inst) sel.value = waveSelValue(inst);
}
// translates a waveform <select>'s value back onto the instrument. Binding the registry entry's buffer
// to instrument.customBuffer here is what keeps playNote()'s `wave==="custom" && customBuffer` branch
// working unchanged — the audio path never learns that a registry exists.
function applyWaveSelection(inst, value){
  const m = /^custom:(\d+)$/.exec(value);
  if(m){
    const s = findSample(Number(m[1]));
    inst.wave = "custom";
    if(s){ inst.sampleId = s.id; inst.customBuffer = s.buffer; }
    return;
  }
  inst.wave = value;
}

/* ---------- waveform <select> progressive abbreviation ----------
   Tier 0 = full word ("Square"), 1 = first letter only ("S"), 2 = no text at all (bare dropdown arrow).
   A plain <select> renders whatever text the *selected* <option> holds, so abbreviating means
   rewriting that option's label; the original is stashed in data-full and restored whenever the
   popup is about to open (mousedown/focus) so the list itself always reads in full words. */
function applyWaveTier(sel, tier){
  if(!sel) return;
  Array.prototype.forEach.call(sel.options, o=>{
    if(o.dataset.full===undefined) o.dataset.full = o.textContent;
    o.textContent = o.dataset.full;
  });
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  if(opt){
    if(tier===1) opt.textContent = (opt.dataset.full||"").charAt(0);
    else if(tier>=2) opt.textContent = "";
  }
  sel.classList.toggle("wtier1", tier===1);
  sel.classList.toggle("wtier2", tier>=2);
}
// shrink the waveform label (and, last resort, the volume slider) until the controls fit beside the name
function fitRowControls(row){
  if(!row) return;
  const ctrls = row.querySelector(".tctrls"), name = row.querySelector(".tname");
  const sel = ctrls && ctrls.querySelector('select[data-role=wave]');
  const vol = ctrls && ctrls.querySelector('input[data-role=vol]');
  if(!ctrls || !name || !sel) return;
  // sample labels are width-derived, and this is the one function every path that changes a row's width
  // already goes through (rebuild, instrument-column resize, select focusout) — so re-fit them here,
  // before the tier loop below starts rewriting the selected option's text
  refreshWaveSampleLabels(sel);
  if(!row.classList.contains("oneline")){
    sel.dataset.wtier = "0"; applyWaveTier(sel, 0);
    if(vol) vol.classList.remove("volNarrow");
    return;
  }
  if(vol) vol.classList.remove("volNarrow");
  // natural (unshrunk) width the name wants: left padding + swatch + gap + measured text.
  // name.scrollWidth would be useless here — the flex shrink has already squashed the input.
  const nameEl = name.querySelector('[data-role=nameText], input[data-role=name]');
  const nameNeed = 8 + 9 + 6 + (nameEl ? Number(nameEl.dataset.natw||0) : 0);
  const avail = row.clientWidth;
  let tier = 0;
  for(tier=0; tier<=2; tier++){
    applyWaveTier(sel, tier);
    if(nameNeed + ctrls.offsetWidth <= avail) break;
  }
  if(tier>2) tier = 2;
  sel.dataset.wtier = String(tier);
  if(tier===2 && vol && nameNeed + ctrls.offsetWidth > avail) vol.classList.add("volNarrow");
}

/* ---------- instrument-editor top row: progressive label truncation ----------
   Same measure-and-shrink idea as fitRowControls above, applied to the two buttons in .instTopRow,
   because #instEditor's width is drag-resizable (see makeResizer on #vResizerInstEditor) and the row
   has nowhere to wrap to. The full word lives in data-full and every pass restarts from it, which is
   what makes widening the panel back out restore the whole label AND drop the ellipsis — the "…" is
   never decoration, it appears only on a label that actually had to give up characters. */
const INST_LABEL_MIN_CHARS = 1; // floor: one character plus the ellipsis ("A…") — never shorter, never hidden
// a button's box is its fixed chrome (padding + border) plus the measured label, so a candidate label's
// width can be computed without laying it out first
function instBtnWidthFor(btn, text){
  const cs = getComputedStyle(btn);
  const chrome = (parseFloat(cs.paddingLeft)||0) + (parseFloat(cs.paddingRight)||0)
               + (parseFloat(cs.borderLeftWidth)||0) + (parseFloat(cs.borderRightWidth)||0);
  const w = measureTextPx(text, cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily);
  return Math.ceil(w + chrome) + 1;
}
function fitInstTopRow(){
  const row = document.querySelector("#instEditor .instTopRow");
  if(!row) return;
  // #sampleMenuBtn only exists in the row once the project has an upload, and it carries a real word
  // like the other two, so it joins the same shrink set — a hidden one is filtered out because
  // display:none takes it out of row.scrollWidth entirely, and shrinking it would burn passes for
  // nothing (it is re-fitted the moment it appears, via refreshInstrumentEditor -> updateSampleMenuBtn)
  const btns = ["advToggleBtn","uploadSampleBtn","sampleMenuBtn"].map(id=>document.getElementById(id))
    .filter(b=>b && !b.classList.contains("hidden"));
  if(!btns.length || !row.clientWidth) return;
  row.classList.remove("squeezed");
  btns.forEach(b=>{
    if(b.dataset.full===undefined) b.dataset.full = (b.textContent||"").trim();
    b.textContent = b.dataset.full;
    b.style.width = instBtnWidthFor(b, b.dataset.full)+"px";
  });
  // chop one character off whichever label still has the most left to give, so the two shrink in step
  // instead of the first one collapsing to "A…" while the second is still showing its full word
  let guard = 64, atFloor = false;
  while(row.scrollWidth > row.clientWidth && guard-- > 0){
    let victim = null, victimLen = INST_LABEL_MIN_CHARS;
    btns.forEach(b=>{
      const cur = b.textContent.replace(/…$/,"");
      if(cur.length > victimLen){ victim = b; victimLen = cur.length; }
    });
    if(!victim){ atFloor = true; break; } // every label is already down to its floor
    const next = victim.textContent.replace(/…$/,"").slice(0, victimLen-1) + "…";
    victim.textContent = next;
    victim.style.width = instBtnWidthFor(victim, next)+"px";
  }
  // both labels are at "A…" and the row STILL doesn't fit — hand the shortfall to the Track / Waveform
  // fields (see .instTopRow.squeezed) so the buttons stay on screen instead of being clipped off the end
  row.classList.toggle("squeezed", atFloor);
}

function buildTrackList(){
  const inner = document.getElementById("trackListInner");
  inner.innerHTML = "";
  const loopBar = document.createElement("div"); loopBar.id="loopBar";
  loopBar.innerHTML = '<div id="loopRegion"><div id="loopHandleL" class="loopHandle"></div><div id="loopHandleR" class="loopHandle"></div></div>';
  inner.appendChild(loopBar);
  const ruler = document.createElement("div"); ruler.id="trackListRuler"; inner.appendChild(ruler);
  const ph = document.createElement("div"); ph.id="trackListPlayhead"; inner.appendChild(ph);
  const flag = document.createElement("div"); flag.id="trackListPlayheadFlag"; inner.appendChild(flag);
  state.tracks.forEach(track=>{
    const row = document.createElement("div");
    row.className="trackRow"; row.style.setProperty("--barpx",BAR_PX+"px");
    row.style.height = TRACK_ROW_H+"px";
    row.dataset.id = track.id;
    if(track.regions && track.regions.length){
      // split into independent regions: each renders as its own block, but all still belong to this one track
      track.regions.forEach(region=>{
        const regionNotes = track.notes.filter(n=> n.step>=region.start && n.step<region.end);
        renderTrackBlock(row, track, region.start, region.end, regionNotes, region.id);
      });
    } else if(track.notes.length){
      const spb = stepsPerBar();
      const minStep = Math.min(...track.notes.map(n=>n.step));
      const maxStep = Math.max(...track.notes.map(n=>n.step+n.dur));
      const startBar = Math.floor(minStep/spb)*spb, endBar = Math.ceil(maxStep/spb)*spb;
      renderTrackBlock(row, track, startBar, endBar, track.notes, null);
    }
    inner.appendChild(row);
  });
  const totalW = (STEPS_TOTAL/stepsPerBar()*BAR_PX+40);
  inner.style.width = totalW+"px";
  renderArrangeRuler(totalW);
  renderPlayheads();
  renderLoopUI();
}

// renders one track block spanning [startStep,endStep) in a track's row of the track list, with a mini note-pattern preview
function renderTrackBlock(row, track, startStep, endStep, notes, regionId){
  const spb = stepsPerBar();
  const left = startStep/spb*BAR_PX;
  const blockW = Math.max(20, (endStep-startStep)/spb*BAR_PX);
  // the block is an opaque track-colored header strip (carrying the name) over a translucent
  // track-colored body — the treatment that used to live on the instrument-list rows
  const blockH = Math.max(16, TRACK_ROW_H - 1 - TRACK_BLOCK_INSET*2);
  const hdrH = Math.min(TRACK_BLOCK_HDR_H, Math.max(9, Math.round(blockH*0.45)));
  const bodyH = Math.max(0, blockH-hdrH);
  const block = document.createElement("div");
  block.className = "trackBlock"+(regionId!=null && selectedRegionIds.has(regionId) ? " regionSelected" : "");
  block.style.left = left+"px";
  block.style.top = TRACK_BLOCK_INSET+"px";
  block.style.width = blockW+"px";
  block.style.height = blockH+"px";
  block.style.boxSizing = "border-box";
  block.style.background = colorWithAlpha(track.color, 0.35);
  if(regionId!=null) block.dataset.regionId = regionId;

  const header = document.createElement("div");
  header.className = "trackBlockHeader";
  header.style.height = hdrH+"px";
  header.style.background = track.color;
  header.style.fontSize = (hdrH<12 ? 8 : 10)+"px";
  header.textContent = track.name;
  block.appendChild(header);

  const pattern = document.createElement("canvas");
  const dpr = window.devicePixelRatio||1;
  pattern.className = "trackBlockPattern";
  pattern.width = Math.max(1, Math.round(blockW*dpr)); pattern.height = Math.max(1, Math.round(bodyH*dpr));
  pattern.style.top = hdrH+"px";
  pattern.style.width=blockW+"px"; pattern.style.height=bodyH+"px";
  const pctx = pattern.getContext("2d"); pctx.scale(dpr,dpr);
  if(notes.length && bodyH>3){
    const totalSteps = Math.max(1, endStep-startStep);
    const pitches = notes.map(n=>n.pitch);
    const minP = Math.min(...pitches), maxP = Math.max(...pitches);
    const range = Math.max(1, maxP-minP);
    const padV = Math.min(3, Math.floor(bodyH/4));
    const travel = Math.max(1, bodyH-padV*2-2);
    pctx.fillStyle = "rgba(0,0,0,.55)";
    notes.forEach(n=>{
      const nx = (n.step-startStep)/totalSteps*blockW;
      const nw = Math.max(1, n.dur/totalSteps*blockW-0.5);
      const t = (n.pitch-minP)/range;
      const ny = (bodyH-padV-2) - t*travel;
      pctx.fillRect(nx, ny, nw, 2);
    });
  }
  block.appendChild(pattern);

  // Deliberately no edge grips: a block's span is not directly resizable. Its length is derived from
  // the notes it contains (or from its region's bounds), and the way to make a block read longer or
  // shorter on screen is the track-zoom slider / pinch gesture, not dragging its edges. The whole
  // block surface is therefore a single drag target for MOVING it sideways.
  row.appendChild(block);
}

// bar-number ruler above the track list, marking measure boundaries
function renderArrangeRuler(totalW){
  const ruler = document.getElementById("trackListRuler");
  if(!ruler) return;
  const h = 18, dpr = window.devicePixelRatio||1;
  const canvas = document.createElement("canvas");
  canvas.width = totalW*dpr; canvas.height = h*dpr;
  canvas.style.width = totalW+"px"; canvas.style.height = h+"px";
  ruler.innerHTML = ""; ruler.appendChild(canvas);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,totalW,h);
  const spb = stepsPerBar(), beats = beatsPerBar();
  const totalBars = Math.ceil(STEPS_TOTAL/spb);
  ctx.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
  ctx.textBaseline = "top";
  for(let bar=0; bar<totalBars; bar++){
    const x = bar*BAR_PX;
    ctx.strokeStyle = "#5a5a68"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+.5, 0); ctx.lineTo(x+.5, h); ctx.stroke();
    ctx.fillStyle = "#b7b7c2";
    ctx.fillText(String(bar+1), x+4, 2);
    ctx.strokeStyle = "#3a3a44";
    for(let b=1; b<beats; b++){
      const bx = x + b*(BAR_PX/beats);
      ctx.beginPath(); ctx.moveTo(bx+.5, h*0.6); ctx.lineTo(bx+.5, h); ctx.stroke();
    }
  }
}

/* ======================================================================
   ADVANCED TRACK EDITOR (AUTOMATION LANES)
   ====================================================================== */
let ADV_LANE_H = 160; // recalculated in renderAdvancedEditor from the lane card's actual measured height
const ADV_LANE_TOP = 22; // must match #advLaneCanvas's CSS top offset (the header's own height — canvas sits flush beneath it, no gap, so header+canvas read as one continuous shape)
const ADV_PARAM_LABELS = {volume:"Volume", pan:"Pan", reverb:"Reverb", eqLow:"EQ Low", eqMid:"EQ Mid", eqHigh:"EQ High"};

// the value (0-100) this parameter shows as a flat line until the user actually draws a curve for it —
// this is what keeps an empty lane in sync with the track's own sliders, per param, rather than a fixed default
function autoDefaultValue(track, param){
  switch(param){
    case "volume": return track.volume*100;
    case "pan": return track.pan;
    case "reverb": return track.instrument.reverb;
    case "eqLow": return (track.instrument.eqLow+24)/48*100;
    case "eqMid": return (track.instrument.eqMid+24)/48*100;
    case "eqHigh": return (track.instrument.eqHigh+24)/48*100;
    default: return 50;
  }
}
function advTrack(){ return state.tracks.find(t=>t.id===state.advancedTrackId); }

function renderAdvancedEditor(){
  const panel = document.getElementById("advancedEditor");
  const track = advTrack();
  // both branches re-place the dock panels, because opening/closing this editor is exactly what decides
  // whether a registered panel floats or docks. It has to happen BEFORE the lane is measured below: a
  // panel docking into #advDockLeft takes width away from #advLaneScroll, and the canvas is sized from
  // that element's live clientWidth/clientHeight.
  if(!track){ panel.classList.add("hidden"); syncDockedPanels(); return; }
  panel.classList.remove("hidden");
  syncDockedPanels();

  document.querySelectorAll(".advTabBtn").forEach(b=> b.classList.toggle("active", b.dataset.param===state.advancedParam));

  const header = document.getElementById("advLaneHeader");
  header.textContent = track.name+" — "+ADV_PARAM_LABELS[state.advancedParam];
  header.style.background = track.color;

  const spb = stepsPerBar();
  // fill at least the visible scroll viewport (plus a little breathing room past it), so the lane's
  // colored backdrop reaches the right edge instead of stopping wherever the last bar happens to be
  const scrollEl = document.getElementById("advLaneScroll");
  const viewportW = scrollEl.clientWidth;
  const totalW = Math.max(1, STEPS_TOTAL/spb*BAR_PX, viewportW-40)+40;
  document.getElementById("advLaneInner").style.width = totalW+"px";
  header.style.width = totalW+"px";

  const laneW = totalW; // canvas now spans the full width, flush with the header above it — together they read as one continuous shape
  // measured fresh each render so the canvas always fits the card's real height (accounting for the horizontal scrollbar), never spilling past its bottom edge
  ADV_LANE_H = Math.max(40, scrollEl.clientHeight - ADV_LANE_TOP);

  const canvas = document.getElementById("advLaneCanvas");
  const dpr = window.devicePixelRatio||1;
  canvas.width = laneW*dpr; canvas.height = ADV_LANE_H*dpr;
  canvas.style.width = laneW+"px"; canvas.style.height = ADV_LANE_H+"px";
  const ctx = canvas.getContext("2d"); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,laneW,ADV_LANE_H);

  // solid track-colored backdrop, echoing the track block's own coloring (and the lane header above it)
  ctx.fillStyle = track.color; ctx.globalAlpha = 0.4; ctx.fillRect(0,0,laneW,ADV_LANE_H); ctx.globalAlpha = 1;

  const points = track.automation[state.advancedParam].slice().sort((a,b)=>a.step-b.step);
  const valueToY = v=> ADV_LANE_H-(v/100*ADV_LANE_H);
  const stepToX = s=> s/spb*BAR_PX;

  // ghost note tiles from the track's own notes, positioned by step/duration and pitch —
  // same idea as the mini note-pattern drawn inside the track list's blocks, so you can read the
  // notes against the automation curve
  if(track.notes.length){
    const pitches = track.notes.map(n=>n.pitch);
    const minP = Math.min(...pitches), maxP = Math.max(...pitches);
    const range = Math.max(1, maxP-minP);
    const tileH = Math.min(16, Math.max(6, ADV_LANE_H/(range+4)));
    const padV = 8; // keeps tiles off the lane's own top/bottom edge, independent of the card's own outer inset
    const travel = Math.max(4, ADV_LANE_H - padV*2 - tileH);
    // The tiles get their OWN horizontal space rather than inheriting the timeline's: the track's note
    // span (earliest start → latest end) is stretched across the lane, inset on both sides, so the
    // pattern fills the rectangle comfortably no matter what BAR_PX is or how far into the project the
    // notes actually sit. Durations stay proportional within that mapping, so a note twice as long
    // still draws twice as wide.
    // Fitted to the VISIBLE rectangle, not the full canvas: laneW carries the lane's scrollable width
    // (STEPS_TOTAL at the current zoom, plus 40px of trailing breathing room), which is routinely wider
    // than the scroll viewport — mapping across it would park the tail of the pattern just off the right
    // edge, which is exactly the "doesn't fit in the rectangle" this mapping exists to fix. The whole
    // preview therefore reads at a glance with no horizontal scrolling.
    // The curve and its draggable dots deliberately stay in the real, unscaled stepToX space: the
    // advPointLayer drag handlers convert pixels back to steps via BAR_PX, so rescaling them here
    // would silently break that math. Only these decorative tiles are remapped.
    const INSET_H = 10;
    const fitW = Math.min(laneW, scrollEl.clientWidth || laneW);
    const innerW = Math.max(1, fitW - INSET_H*2);
    const spanStart = Math.min(...track.notes.map(n=>n.step));
    const spanEnd = Math.max(...track.notes.map(n=>n.step+n.dur));
    // a lone note (or any zero-width span) would otherwise divide by zero — one step is the smallest
    // span that still maps to a real width, and the per-tile Math.max(2,…) below keeps it visible
    const span = Math.max(1, spanEnd-spanStart);
    const tileX = s=> INSET_H + (s-spanStart)/span*innerW;
    ctx.fillStyle = "rgba(216,255,230,.55)"; // near-white mint green, echoing the accent color
    track.notes.forEach(n=>{
      const nx = tileX(n.step);
      const nw = Math.max(2, tileX(n.step+n.dur)-nx-1);
      const t = (n.pitch-minP)/range;
      const centerY = (ADV_LANE_H-padV-tileH/2) - t*travel;
      ctx.beginPath();
      ctx.roundRect(nx, centerY-tileH/2, nw, tileH, 2);
      ctx.fill();
    });
  }

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if(points.length===0){
    const y = valueToY(autoDefaultValue(track, state.advancedParam));
    ctx.moveTo(0,y); ctx.lineTo(laneW,y);
  } else {
    ctx.moveTo(0, valueToY(points[0].value));
    points.forEach(p=> ctx.lineTo(stepToX(p.step), valueToY(p.value)));
    ctx.lineTo(laneW, valueToY(points[points.length-1].value));
  }
  ctx.stroke();

  const layer = document.getElementById("advPointLayer");
  layer.innerHTML = "";
  points.forEach(p=>{
    const dot = document.createElement("div");
    dot.className = "autoPoint"+(selectedAutoPointIds.has(p.id)?" selected":"");
    dot.style.left = stepToX(p.step)+"px";
    dot.style.top = valueToY(p.value)+"px";
    dot.dataset.id = p.id;
    dot.title = Math.round(p.value)+"%";
    layer.appendChild(dot);
  });
}

let autoDrag = null; // {trackId, param, origin:[{id,step,value}], startStep, startValue}

document.getElementById("advTabs").addEventListener("click",(e)=>{
  const btn = e.target.closest(".advTabBtn"); if(!btn) return;
  state.advancedParam = btn.dataset.param;
  selectedAutoPointIds.clear();
  renderAdvancedEditor();
});
document.getElementById("advToggleBtn").addEventListener("click", ()=>{
  const t = selectedTrack(); if(!t) return;
  if(state.advancedTrackId===t.id){ state.advancedTrackId = null; }
  else { state.advancedTrackId = t.id; state.advancedParam = "volume"; selectedAutoPointIds.clear(); }
  refreshInstrumentEditor();
  renderAdvancedEditor();
});
document.getElementById("advCloseBtn").addEventListener("click", ()=>{
  state.advancedTrackId = null; selectedAutoPointIds.clear();
  refreshInstrumentEditor();
  renderAdvancedEditor();
});
// double-click empty lane space to drop a new automation point at that step/value
document.getElementById("advPointLayer").addEventListener("dblclick",(e)=>{
  if(e.target.classList.contains("autoPoint")) return;
  const track = advTrack(); if(!track) return;
  const rect = document.getElementById("advLaneCanvas").getBoundingClientRect();
  const spb = stepsPerBar();
  const step = Math.max(0, (e.clientX-rect.left)/BAR_PX*spb);
  const value = Math.max(0, Math.min(100, 100-(e.clientY-rect.top)/ADV_LANE_H*100));
  pushHistory();
  track.automation[state.advancedParam].push({id: nextNoteId++, step, value});
  renderAdvancedEditor();
});
document.getElementById("advPointLayer").addEventListener("mousedown",(e)=>{
  const dot = e.target.closest(".autoPoint"); if(!dot) return;
  const track = advTrack(); if(!track) return;
  const id = Number(dot.dataset.id);
  if(e.shiftKey){
    // shift-click toggles this dot into/out of the multi-selection, without starting a drag
    if(selectedAutoPointIds.has(id)) selectedAutoPointIds.delete(id); else selectedAutoPointIds.add(id);
    renderAdvancedEditor();
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if(!selectedAutoPointIds.has(id)){ selectedAutoPointIds.clear(); selectedAutoPointIds.add(id); renderAdvancedEditor(); }
  pushHistory();
  const points = track.automation[state.advancedParam];
  const origin = points.filter(p=>selectedAutoPointIds.has(p.id)).map(p=>({id:p.id, step:p.step, value:p.value}));
  const rect = document.getElementById("advLaneCanvas").getBoundingClientRect();
  const spb = stepsPerBar();
  autoDrag = {
    trackId: track.id, param: state.advancedParam, origin,
    startStep: (e.clientX-rect.left)/BAR_PX*spb,
    startValue: 100-(e.clientY-rect.top)/ADV_LANE_H*100
  };
  e.preventDefault(); e.stopPropagation();
});

/* ======================================================================
   INSTRUMENT EDITOR SYNC
   ====================================================================== */
function refreshInstrumentEditor(){
  const track = selectedTrack();
  const editor = document.getElementById("instEditor");
  const advBtn = document.getElementById("advToggleBtn");
  // before the early return: the sample-manager button's presence depends on the REGISTRY, not on
  // which track (if any) happens to be selected, and .instTopRow's fit has to account for it either way
  updateSampleMenuBtn();
  if(!track){ editor.style.opacity=.4; editor.style.pointerEvents="none"; advBtn.classList.remove("on"); fitInstTopRow(); return; }
  editor.style.opacity=1; editor.style.pointerEvents="auto";
  document.getElementById("instTrackName").textContent = track.name;
  advBtn.classList.toggle("on", state.advancedTrackId===track.id);
  const inst = track.instrument;
  syncWaveCustomOptions(document.getElementById("waveSel"), inst, "Custom Sample");
  document.getElementById("volSlider").value = Math.round((track.volume)*100);
  document.getElementById("volVal").textContent = Math.round(track.volume*100);
  document.getElementById("atkSlider").value = inst.attack; document.getElementById("atkVal").textContent = inst.attack+"ms";
  document.getElementById("relSlider").value = inst.release; document.getElementById("relVal").textContent = inst.release+"ms";
  document.getElementById("eqLowSlider").value = inst.eqLow; document.getElementById("eqLowVal").textContent = inst.eqLow+"dB";
  document.getElementById("eqMidSlider").value = inst.eqMid; document.getElementById("eqMidVal").textContent = inst.eqMid+"dB";
  document.getElementById("eqHighSlider").value = inst.eqHigh; document.getElementById("eqHighVal").textContent = inst.eqHigh+"dB";
  document.getElementById("revSlider").value = inst.reverb; document.getElementById("revVal").textContent = inst.reverb+"%";
  // the sample's name now rides in the waveform dropdown itself, so this span has nothing left to add
  // in the normal case and stays empty (which also stops it competing with the buttons for row width).
  // It only speaks up where the dropdown genuinely can't: a track set to "custom" that the registry
  // can't name — a project reloaded from JSON, which never carries the audio itself.
  const named = findSample(inst.sampleId);
  document.getElementById("sampleName").textContent =
    (inst.wave==="custom" && !named) ? (inst.customBuffer ? "sample loaded" : "no sample") : "";
  // the track name just changed width, which changes how much of the top row is left for the
  // buttons beside it — re-fit their labels against the row as it now measures
  fitInstTopRow();
}

/* ======================================================================
   SELECT / ADD TRACK
   ====================================================================== */
function selectTrack(id, opts){
  state.selectedTrackId = id;
  editContext = "track";
  selectedNoteIds.clear();
  phantomSelection = null;
  renderInstrumentList(); refreshInstrumentEditor(); renderNotes();
  // renderInstrumentList() rebuilds the list from scratch (which would otherwise reset its scroll
  // container to the very first instrument) — bring the newly selected row back into the middle of
  // the view. Rows that are already fully visible are left alone, so ordinary clicking doesn't make
  // the list lurch under the cursor mid-gesture (e.g. between the two clicks of a rename).
  centerSelectedInstrumentRow({onlyIfOffscreen:true});
  if(opts && opts.scrollToFirstNote) scrollGridToFirstNote(id);
}
// bring the piano roll to wherever a track's earliest note sits, with that note pinned near the left edge
function scrollGridToFirstNote(trackId){
  const track = state.tracks.find(t=>t.id===trackId);
  if(!track || !track.notes.length) return;
  const firstNote = track.notes.reduce((a,b)=> b.step<a.step ? b : a);
  gridScroll.scrollLeft = Math.max(0, firstNote.step*STEP_W - 40);
  const row = midiToRow(firstNote.pitch);
  gridScroll.scrollTop = Math.max(0, row*ROW_H+GRID_RULER_H - gridScroll.clientHeight/2);
  syncPianoScroll();
}
// the phantom cell spans state.noteLenSteps steps, so its start has to stop far enough from the right
// edge that the whole span still fits inside the grid
function clampPhantomStep(step){
  return Math.max(0, Math.min(step, STEPS_TOTAL - state.noteLenSteps));
}

// Minimal "nudge into view" for whatever is currently selected (real notes or the phantom cell).
// Only moves an axis that's actually out of view, and only far enough to make the offending edge flush
// with the viewport border — never centers, never overshoots.
//
// Coordinate space: gridScroll.scrollTop/scrollLeft are in #gridInner's coordinate space, and #gridInner
// reserves a real GRID_RULER_H band above the row content (see resizeGrid: height = h + GRID_RULER_H),
// so a row's content-space top is row*ROW_H + GRID_RULER_H. On top of that #gridRuler is position:sticky
// top:0, so it permanently covers the first GRID_RULER_H pixels of the viewport — the genuinely visible
// vertical band is [scrollTop + GRID_RULER_H, scrollTop + clientHeight]. Both offsets cancel on the top
// edge (boxTop - GRID_RULER_H === row*ROW_H) but not on the bottom. Horizontally there is no such band.
function scrollSelectionIntoView(){
  let boxLeft, boxRight, boxTop, boxBottom;
  const track = selectedTrack();
  if(track && selectedNoteIds.size){
    const notes = track.notes.filter(n=>selectedNoteIds.has(n.id));
    if(!notes.length) return;
    notes.forEach(n=>{
      const row = midiToRow(n.pitch);
      const l = n.step*STEP_W, r = (n.step+n.dur)*STEP_W;
      const t = row*ROW_H + GRID_RULER_H, b = t + ROW_H;
      boxLeft = boxLeft==null ? l : Math.min(boxLeft, l);
      boxRight = boxRight==null ? r : Math.max(boxRight, r);
      boxTop = boxTop==null ? t : Math.min(boxTop, t);
      boxBottom = boxBottom==null ? b : Math.max(boxBottom, b);
    });
  } else if(phantomSelection){
    boxLeft = phantomSelection.step*STEP_W;
    boxRight = (phantomSelection.step+state.noteLenSteps)*STEP_W;
    boxTop = phantomSelection.row*ROW_H + GRID_RULER_H;
    boxBottom = boxTop + ROW_H;
  } else return;

  const viewW = gridScroll.clientWidth, viewH = gridScroll.clientHeight;
  if(boxLeft < gridScroll.scrollLeft) gridScroll.scrollLeft = boxLeft;
  else if(boxRight > gridScroll.scrollLeft + viewW) gridScroll.scrollLeft = boxRight - viewW;

  // the sticky ruler eats the top GRID_RULER_H px of the viewport, so the top edge has to clear it
  if(boxTop - GRID_RULER_H < gridScroll.scrollTop) gridScroll.scrollTop = boxTop - GRID_RULER_H;
  else if(boxBottom > gridScroll.scrollTop + viewH) gridScroll.scrollTop = boxBottom - viewH;
  // gridScroll's own "scroll" listener runs syncPianoScroll() for us
}

function addTrack(){
  pushHistory();
  const t = makeTrack("Track "+nextTrackId, state.tracks.length);
  buildChain(t);
  state.tracks.push(t);
  selectTrack(t.id);
  toast("Added "+t.name);
}
function deleteSelectedTrack(){
  const track = selectedTrack(); if(!track) return;
  if(!confirm('Delete "'+track.name+'"?')) return;
  pushHistory();
  state.tracks = state.tracks.filter(t=>t.id!==track.id);
  state.selectedTrackId = state.tracks.length? state.tracks[0].id : null;
  if(state.advancedTrackId===track.id){ state.advancedTrackId=null; selectedAutoPointIds.clear(); }
  renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); renderAdvancedEditor();
}

/* ======================================================================
   NOTE EDITING: click-add, drag-select, drag-move, copy/paste
   ====================================================================== */
let drag = null; // {mode:'select'|'move'|'place', startX,startY, origin notes...}
let playheadDrag = null; // {type:'grid'|'trackList'}
let loopDrag = null; // {mode:'move'|'resizeL'|'resizeR', ...}
let trackDrag = null; // {trackId, startX, origin}
let suppressTrackListClick = false;

// true only while the current note selection is the one PLACEMENT itself just made — see the
// empty-cell branch of onGridMouseDown, which has to keep placing notes on consecutive clicks now
// that placing one selects it
let selectionFromPlacement = false;

/* ---------- selecting a note tile is exclusive across the whole app ----------
   Region blocks in the track list, automation dots in the advanced editor, the phantom keyboard cursor
   and a focused button/dropdown/slider all answer the same question — "what does the next keypress act
   on?" — so exactly one of them may be lit at a time, and a note tile winning clears the rest.
   Each panel is only re-rendered when its own selection actually had something in it, so the common
   case (clicking tile after tile with nothing else selected) stays a plain renderNotes(). */
function clearNonNoteSelections(){
  if(selectedRegionIds.size){ selectedRegionIds.clear(); buildTrackList(); }
  if(selectedAutoPointIds.size){ selectedAutoPointIds.clear(); renderAdvancedEditor(); }
  // the phantom cell is already mutually exclusive with selectedNoteIds; clearing it here is what
  // makes that invariant hold for every selection path rather than only the ones that remembered to
  phantomSelection = null;
  selectionFromPlacement = false;
  blurFocusedControl();
}
// replaces the note selection with exactly `ids` and nothing else, anywhere in the app. Callers that
// ADD to the existing selection (shift-click, rubber band) set selectedNoteIds themselves and call
// clearNonNoteSelections() instead. Neither renders the notes — every caller already does.
function selectNotesExclusively(ids, fromPlacement){
  selectedNoteIds = new Set(ids);
  clearNonNoteSelections();
  selectionFromPlacement = !!fromPlacement;
}

function xyToStepRow(clientX, clientY){
  const rect = gridInner.getBoundingClientRect();
  const x = clientX-rect.left, y = clientY-rect.top;
  // x/y stay raw (gridInner-relative) since that's the same coordinate space the note layer and
  // selection box already render in (both pushed down by GRID_RULER_H via CSS) — only the row index
  // needs the ruler's reserved band subtracted out before dividing into row units
  return { step: Math.floor(x/STEP_W), row: Math.floor((y-GRID_RULER_H)/ROW_H), x, y };
}

// largest duration (in steps) startable at `step` in `row` before hitting the next note, so tiles never overlap
function noteOverlapMaxDur(track, row, step, desiredDur, excludeId){
  let maxDur = desiredDur;
  track.notes.forEach(n=>{
    if(n.id===excludeId) return;
    if(midiToRow(n.pitch)===row && n.step>step){
      maxDur = Math.min(maxDur, n.step-step);
    }
  });
  return Math.max(1, maxDur);
}

// earliest step a note can be trimmed back to from the left, given its right edge stays fixed at
// `fixedEnd` — the mirror of noteOverlapMaxDur, so trimming from the left can't cross an earlier tile
function noteOverlapMinStep(track, row, fixedEnd, excludeId){
  let minStep = 0;
  track.notes.forEach(n=>{
    if(n.id===excludeId) return;
    if(midiToRow(n.pitch)===row && n.step+n.dur<=fixedEnd){
      minStep = Math.max(minStep, n.step+n.dur);
    }
  });
  return Math.min(minStep, fixedEnd-1);
}

noteLayer.addEventListener("mousedown", onGridMouseDown);
gridCanvas.addEventListener("mousedown", onGridMouseDown);

// double-click a tile to delete it; double-click empty space to toggle phantom (keyboard-only)
// navigation of empty cells on and off
noteLayer.addEventListener("dblclick", (e)=>{
  const track = selectedTrack(); if(!track) return;
  const {step,row} = xyToStepRow(e.clientX,e.clientY);
  const hitNote = track.notes.find(n=> row===midiToRow(n.pitch) && step>=n.step && step<n.step+n.dur);
  // a double-click's own first click already ran onGridMouseDown's empty-cell "place" logic and created
  // a note before this handler ever saw the cell — so a real double-click on originally-empty space
  // still finds a hitNote here. Distinguish that from an intentional double-click-to-delete of a
  // pre-existing note by checking whether this exact note was placed moments ago by this same gesture.
  const isTransientPlacement = hitNote && hitNote.id===justPlacedNoteId
    && (performance.now()-justPlacedAt) < JUST_PLACED_WINDOW_MS;
  if(!hitNote || isTransientPlacement){
    if(isTransientPlacement){
      if(undoStack.length) undoStack.pop(); // cancel the placement's own checkpoint — net state is unchanged
      track.notes = track.notes.filter(n=>n.id!==hitNote.id);
      selectedNoteIds.delete(hitNote.id);
      justPlacedNoteId = null;
      buildTrackList(); recomputeStepsTotal();
    }
    phantomSelection = phantomSelection ? null : {step:clampPhantomStep(step), row};
    renderNotes();
    if(phantomSelection) scrollSelectionIntoView();
    e.stopPropagation(); e.preventDefault();
    return;
  }
  pushHistory();
  track.notes = track.notes.filter(n=>n.id!==hitNote.id);
  selectedNoteIds.delete(hitNote.id);
  renderNotes(); buildTrackList(); recomputeStepsTotal();
  e.stopPropagation(); e.preventDefault();
});

function onGridMouseDown(e){
  const track = selectedTrack(); if(!track) return;
  editContext = "notes";

  // the mirrored grip on a tile's left edge: drag to trim the start of the note while its right edge
  // (and any slur target) stays put
  if(e.target.classList && e.target.classList.contains("leftHandle")){
    const noteEl = e.target.closest(".note");
    const note = track.notes.find(n=>n.id===Number(noteEl.dataset.id));
    if(note){
      pushHistory();
      drag = {mode:"resizeLeft", noteId:note.id, fixedEnd:note.step+note.dur};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  // the little grip on a tile's right edge: drag sideways to resize, or (only if the note isn't already
  // slurred) up/down to start a new slur — once a slur exists, its target is adjusted via the separate
  // bendStub instead, so this handle stays dedicated to length once that stub appears
  if(e.target.classList && e.target.classList.contains("bendHandle")){
    const noteEl = e.target.closest(".note");
    const note = track.notes.find(n=>n.id===Number(noteEl.dataset.id));
    if(note){
      pushHistory();
      // the slur target maps 1:1 to the row the cursor is over (so it always matches where notes sit
      // elsewhere on the grid), but that mapping only "engages" once the mouse has actually moved some
      // vertical distance — otherwise just touching the grip to resize horizontally would instantly
      // snap an existing slur back to the note's own pitch
      drag = {mode:"bend", noteId:note.id, startClientY:e.clientY, bendEngaged:false, allowBend: note.bendTo==null, lastPreviewPitch:null};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  // the small stub on a slurred note: drag it up/down to retarget the slur pitch, or sideways to
  // change how much of the tile the slide takes up (the note's own length stays the resize handle's job)
  if(e.target.classList && e.target.classList.contains("bendStub")){
    const note = track.notes.find(n=>n.id===Number(e.target.dataset.id));
    if(note){
      pushHistory();
      drag = {mode:"bendAdjust", noteId:note.id, lastPreviewPitch:null};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  // the dot where the slur's slide-line meets the tile: drag it sideways to move where within the
  // note the pitch actually starts sliding, independent of the note's own length or slur target
  if(e.target.classList && e.target.classList.contains("bendStartHandle")){
    const note = track.notes.find(n=>n.id===Number(e.target.dataset.id));
    if(note){
      pushHistory();
      drag = {mode:"bendStartAdjust", noteId:note.id};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  const {step,row,x,y} = xyToStepRow(e.clientX,e.clientY);

  // grab the playhead if the click lands near its current position
  const phX = currentPlayStep()*STEP_W;
  if(Math.abs(x-phX)<=5){
    if(state.playing) stopPlayback(false);
    playheadDrag = {type:"grid"};
    e.preventDefault();
    return;
  }

  if(step<0||step>=STEPS_TOTAL||row<0||row>=TOTAL_ROWS) return;

  if(e.shiftKey || e.altKey){
    // rubber band select — keeps whatever's already selected and adds whatever the band covers
    drag = {mode:"select", x0:x, y0:y, baseline:new Set(selectedNoteIds)};
    const box = document.getElementById("selectionBox");
    box.style.display="block"; box.style.left=x+"px"; box.style.top=y+"px"; box.style.width="0px"; box.style.height="0px";
    e.preventDefault();
    return;
  }

  // is there a note at this cell? Look it up by grid position (not by which DOM element the
  // click happened to land on) so clicking anywhere on/near a tile always selects it — never deletes it.
  const hitNote = track.notes.find(n=> row===midiToRow(n.pitch) && step>=n.step && step<n.step+n.dur);
  if(hitNote){
    if(e.detail>=2){ e.preventDefault(); return; } // double-click: let the dblclick handler delete it
    // a tile winning the selection clears every other kind of selection in the app (regions,
    // automation dots, the phantom cell) and drops focus off whatever control was last clicked
    clearNonNoteSelections();
    // slurred tiles preview the slide itself (base pitch sliding into the target) rather than just
    // the base pitch alone, compressed into the same short preview length
    if(!state.playing) previewNote(track, hitNote.pitch, hitNote.bendTo);
    if(!selectedNoteIds.has(hitNote.id)){
      if(!e.shiftKey) selectedNoteIds.clear();
      selectedNoteIds.add(hitNote.id);
      renderNotes(); scrollSelectionIntoView();
    } else if(e.shiftKey){
      selectedNoteIds.delete(hitNote.id); renderNotes(); scrollSelectionIntoView(); return;
    }
    pushHistory();
    const originNotes = track.notes.filter(n=>selectedNoteIds.has(n.id)).map(n=>({id:n.id, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null}));
    drag = {mode:"move", startStep:step, startMidiRow:row, origin:originNotes, moved:false, lastPreviewPitch:hitNote.pitch};
    e.preventDefault();
    return;
  }

  // empty cell with an existing selection: the first click just clears it, matching how clicking empty
  // space deselects elsewhere — placing a new note is a deliberate second click, not a side effect of
  // dismissing whatever was highlighted.
  // The exception is a selection that placement itself just made: now that placing a tile selects it,
  // letting that selection swallow the next click would turn note entry into two clicks per note.
  if(selectedNoteIds.size && !selectionFromPlacement){
    selectedNoteIds.clear();
    renderNotes();
    e.preventDefault();
    return;
  }

  // empty cell: hold + drag sets a custom note length (start -> end point); a short click places the default length
  pushHistory();
  drag = {mode:"place", row, startStep:step, pitch:rowToMidi(row), downX:e.clientX, downY:e.clientY, dragged:false, noteId:null};
  e.preventDefault();
}

function previewNote(track, midi, bendTo){
  playNote(track, midi, actx.currentTime+0.01, 0.18, bendTo);
}

window.addEventListener("mousemove", (e)=>{
  if(autoDrag){
    const track = state.tracks.find(t=>t.id===autoDrag.trackId);
    if(track){
      const rect = document.getElementById("advLaneCanvas").getBoundingClientRect();
      const spb = stepsPerBar();
      const curStep = (e.clientX-rect.left)/BAR_PX*spb;
      const curValue = 100-(e.clientY-rect.top)/ADV_LANE_H*100;
      const dStep = curStep-autoDrag.startStep, dValue = curValue-autoDrag.startValue;
      const points = track.automation[autoDrag.param];
      autoDrag.origin.forEach(o=>{
        const p = points.find(x=>x.id===o.id); if(!p) return;
        p.step = Math.max(0, o.step+dStep);
        p.value = Math.max(0, Math.min(100, o.value+dValue));
      });
      renderAdvancedEditor();
    }
    return;
  }
  if(loopDrag){
    const rect = document.getElementById("trackListInner").getBoundingClientRect();
    const stepAt = (e.clientX-rect.left)/BAR_PX*stepsPerBar();
    if(loopDrag.mode==="resizeL"){
      state.loop.start = Math.max(0, Math.min(state.loop.end-1, Math.round(stepAt)));
    } else if(loopDrag.mode==="resizeR"){
      state.loop.end = Math.max(state.loop.start+1, Math.min(STEPS_TOTAL, Math.round(stepAt)));
    } else if(loopDrag.mode==="move"){
      const len = loopDrag.startEnd-loopDrag.startStart;
      const delta = Math.round(stepAt-loopDrag.downStep);
      const newStart = Math.max(0, Math.min(STEPS_TOTAL-len, loopDrag.startStart+delta));
      state.loop.start = newStart; state.loop.end = newStart+len;
    }
    renderLoopUI();
    return;
  }
  if(trackDrag){
    const track = state.tracks.find(t=>t.id===trackDrag.trackId);
    if(track){
      const deltaSteps = Math.round((e.clientX-trackDrag.startX)/BAR_PX*stepsPerBar());
      const minOrigin = trackDrag.origin.length ? Math.min(...trackDrag.origin.map(o=>o.step)) : 0;
      const lowerBound = Math.max(-minOrigin, trackDrag.minDelta);
      const clampedDelta = Math.max(lowerBound, Math.min(trackDrag.maxDelta, deltaSteps));
      trackDrag.origin.forEach(o=>{
        const n = track.notes.find(x=>x.id===o.id); if(!n) return;
        n.step = o.step+clampedDelta;
      });
      if(trackDrag.originRegions && track.regions){
        trackDrag.originRegions.forEach(o=>{
          const r = track.regions.find(x=>x.id===o.id); if(!r) return;
          r.start = Math.max(0, o.start+clampedDelta); r.end = Math.max(r.start+1, o.end+clampedDelta);
        });
      }
      if(track.id===state.selectedTrackId) renderNotes();
      buildTrackList();
    }
    return;
  }
  if(playheadDrag){
    let step;
    if(playheadDrag.type==="grid"){
      const rect = gridInner.getBoundingClientRect();
      step = (e.clientX-rect.left)/STEP_W;
    } else {
      const rect = document.getElementById("trackListInner").getBoundingClientRect();
      step = (e.clientX-rect.left)/BAR_PX*stepsPerBar();
    }
    state.playStartStep = Math.max(0, Math.min(STEPS_TOTAL, step));
    renderPlayheads();
    return;
  }
  if(!drag) return;
  const track = selectedTrack(); if(!track) return;
  const {step,row,x,y} = xyToStepRow(e.clientX,e.clientY);

  if(drag.mode==="select"){
    const box = document.getElementById("selectionBox");
    const left = Math.min(drag.x0,x), top=Math.min(drag.y0,y);
    const w = Math.abs(x-drag.x0), h=Math.abs(y-drag.y0);
    box.style.left=left+"px"; box.style.top=top+"px"; box.style.width=w+"px"; box.style.height=h+"px";
    const s0=Math.floor(left/STEP_W), s1=Math.ceil((left+w)/STEP_W);
    const r0=Math.floor((top-GRID_RULER_H)/ROW_H), r1=Math.ceil((top+h-GRID_RULER_H)/ROW_H);
    selectedNoteIds = new Set(drag.baseline);
    track.notes.forEach(n=>{
      const r = midiToRow(n.pitch);
      if(n.step+n.dur>s0 && n.step<s1 && r>=r0 && r<r1) selectedNoteIds.add(n.id);
    });
    // the band sweeping over its first tile makes notes the selection, so everything else deselects —
    // the helper's own guards keep this from rebuilding anything on the frames after that first one
    if(selectedNoteIds.size) clearNonNoteSelections();
    renderNotes();
  } else if(drag.mode==="move"){
    const dStep = step-drag.startStep, dRow = row-drag.startMidiRow;
    const movingIds = new Set(drag.origin.map(o=>o.id));
    const candidates = drag.origin.map(o=>({
      id:o.id, dur:o.dur,
      newStep: Math.max(0, Math.min(STEPS_TOTAL-o.dur, o.step+dStep)),
      newPitch: Math.max(0, Math.min(127, o.pitch-dRow)),
      newBendTo: o.bendTo!=null ? Math.max(0, Math.min(127, o.bendTo-dRow)) : null
    }));
    const valid = candidates.every(c=>{
      const r = midiToRow(c.newPitch);
      return !track.notes.some(n=> !movingIds.has(n.id) && midiToRow(n.pitch)===r && c.newStep < n.step+n.dur && c.newStep+c.dur > n.step);
    });
    if(valid && (dStep!==0||dRow!==0)){
      drag.moved=true;
      candidates.forEach(c=>{
        const n = track.notes.find(x=>x.id===c.id); if(!n) return;
        n.step=c.newStep; n.pitch=c.newPitch; n.bendTo=c.newBendTo;
      });
      renderNotes();
      if(dRow!==0 && candidates.length){
        const pitchNow = candidates[0].newPitch;
        if(drag.lastPreviewPitch!==pitchNow){
          if(!state.playing) previewNote(track, pitchNow);
          drag.lastPreviewPitch = pitchNow;
        }
      }
    }
    showTooltip(e.clientX, e.clientY, "Δstep "+dStep+"  Δpitch "+(-dRow));
  } else if(drag.mode==="place"){
    const dx = Math.abs(e.clientX-drag.downX), dy = Math.abs(e.clientY-drag.downY);
    if(!drag.dragged && (dx>5||dy>5)) drag.dragged = true;
    if(drag.dragged){
      const endStep = Math.max(drag.startStep, step);
      const desiredDur = endStep - drag.startStep + 1;
      const dur = noteOverlapMaxDur(track, drag.row, drag.startStep, desiredDur, drag.noteId);
      if(drag.noteId==null){
        drag.noteId = nextNoteId++;
        const newNote = {id:drag.noteId, step:drag.startStep, pitch:drag.pitch, dur, bendTo:null};
        track.notes.push(newNote);
        extendRegionsForNote(track, newNote);
        // a placed tile IS the selection, so the length can be retyped or the tile nudged straight
        // away — same for the drag-a-custom-length path as for a plain click (see the mouseup branch)
        selectNotesExclusively([newNote.id], true);
        previewNote(track, drag.pitch);
      } else {
        const n = track.notes.find(nn=>nn.id===drag.noteId);
        if(n) n.dur = dur;
      }
      renderNotes();
      showTooltip(e.clientX, e.clientY, dur+" step"+(dur===1?"":"s"));
    }
  } else if(drag.mode==="bend"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      // horizontal movement resizes the note's length, same as dragging a fresh tile's end point
      const endStep = Math.max(note.step, step);
      const desiredDur = endStep - note.step + 1;
      const newDur = noteOverlapMaxDur(track, midiToRow(note.pitch), note.step, desiredDur, note.id);
      if(newDur!==note.dur){
        note.dur = newDur;
        extendRegionsForNote(track, note);
      }

      // vertical movement starts a new slur/tie target — only while the note has no slur yet, though:
      // once a bendStub exists, this handle stays dedicated to length and the stub handles retargeting.
      // the cursor's row maps straight to a pitch, 1:1 with wherever notes actually sit on the grid, but
      // that mapping only "engages" once the mouse has moved a few real pixels vertically, so a
      // horizontal-only resize can't accidentally start a slur
      if(drag.allowBend){
        if(!drag.bendEngaged && Math.abs(e.clientY-drag.startClientY)>5) drag.bendEngaged = true;
        if(drag.bendEngaged){
          const clampedRow = Math.max(0, Math.min(TOTAL_ROWS-1, row));
          const newPitch = rowToMidi(clampedRow);
          if(newPitch !== (note.bendTo??note.pitch)){
            note.bendTo = newPitch===note.pitch ? null : newPitch;
          }
          // announce whatever pitch is currently under the cursor while the slur is being dragged out,
          // same as retargeting an existing slur via the bendStub does
          if(drag.lastPreviewPitch!==newPitch){
            if(!state.playing) previewNote(track, newPitch);
            drag.lastPreviewPitch = newPitch;
          }
        }
      }

      renderNotes();
      const lenText = note.dur+" step"+(note.dur===1?"":"s");
      showTooltip(e.clientX, e.clientY, note.bendTo!=null ? lenText+" · slur to "+midiToName(note.bendTo) : lenText);
    }
  } else if(drag.mode==="bendAdjust"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      let changed = false;
      const clampedRow = Math.max(0, Math.min(TOTAL_ROWS-1, row));
      const newPitch = rowToMidi(clampedRow);
      if(newPitch !== (note.bendTo??note.pitch)){
        note.bendTo = newPitch===note.pitch ? null : newPitch;
        changed = true;
      }
      // sideways movement independently adjusts how much of the tile's tail is held at the target pitch
      // (vs. still sliding), by moving where the stub's left edge — and thus the slide's end point — sits
      const minEnd = clampedBendStartStep(note)+0.15, maxEnd = note.dur;
      const rawEnd = (x-note.step*STEP_W)/STEP_W;
      const newBendEnd = Math.round(Math.max(minEnd, Math.min(maxEnd, rawEnd))*4)/4;
      if(newBendEnd !== (note.bendEndStep==null?note.dur:note.bendEndStep)){
        note.bendEndStep = newBendEnd;
        changed = true;
      }
      if(changed) renderNotes();
      // announce whatever pitch the stub is currently hovering over, same as dragging a note
      // vertically previews its new pitch — only re-fires when the hovered row actually changes
      if(drag.lastPreviewPitch!==newPitch){
        if(!state.playing) previewNote(track, newPitch);
        drag.lastPreviewPitch = newPitch;
      }
      showTooltip(e.clientX, e.clientY, note.bendTo!=null ? "slur to "+midiToName(note.bendTo) : "slur removed");
    }
  } else if(drag.mode==="resizeLeft"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      const fixedEnd = drag.fixedEnd;
      const minStep = noteOverlapMinStep(track, midiToRow(note.pitch), fixedEnd, note.id);
      const newStep = Math.max(minStep, Math.min(fixedEnd-1, step));
      if(newStep!==note.step){
        note.step = newStep;
        note.dur = fixedEnd-newStep;
        extendRegionsForNote(track, note);
        renderNotes();
      }
      showTooltip(e.clientX, e.clientY, note.dur+" step"+(note.dur===1?"":"s"));
    }
  } else if(drag.mode==="bendStartAdjust"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      const max = Math.max(0, note.dur-0.15);
      const raw = (x - note.step*STEP_W)/STEP_W;
      const newBendStart = Math.round(Math.max(0, Math.min(max, raw))*4)/4; // snap to quarter-steps for a steady drag feel
      if(newBendStart!==note.bendStartStep){
        note.bendStartStep = newBendStart;
        renderNotes();
      }
      showTooltip(e.clientX, e.clientY, "slur begins at step "+(note.step+newBendStart));
    }
  }
});
window.addEventListener("mouseup", ()=>{
  endHistoryGesture();
  if(autoDrag){ autoDrag=null; return; }
  if(loopDrag){ loopDrag=null; return; }
  if(trackDrag){ trackDrag=null; document.body.style.cursor=""; recomputeStepsTotal(); return; }
  if(playheadDrag){
    if(playheadDrag.type==="trackList") suppressTrackListClick = true;
    playheadDrag=null;
    return;
  }
  if(drag){
    if(drag.mode==="select"){ document.getElementById("selectionBox").style.display="none"; scrollSelectionIntoView(); }
    if(drag.mode==="move" && drag.moved){ buildTrackList(); recomputeStepsTotal(); }
    if(drag.mode==="place"){
      const track = selectedTrack();
      if(track){
        if(!drag.dragged){
          const dur = noteOverlapMaxDur(track, drag.row, drag.startStep, state.noteLenSteps, null);
          const newNote = {id: nextNoteId++, step:drag.startStep, pitch:drag.pitch, dur, bendTo:null};
          track.notes.push(newNote);
          extendRegionsForNote(track, newNote);
          justPlacedNoteId = newNote.id; justPlacedAt = performance.now();
          // the note the user just placed becomes the selection (and clears every other one), so its
          // type can be changed from the Note Length dropdown without hunting for it again
          selectNotesExclusively([newNote.id], true);
          if(!state.playing) previewNote(track, drag.pitch);
          renderNotes();
        }
        buildTrackList();
        recomputeStepsTotal();
      }
    }
    if(drag.mode==="bend" || drag.mode==="bendAdjust" || drag.mode==="resizeLeft"){ buildTrackList(); recomputeStepsTotal(); }
  }
  drag=null; hideTooltip();
});

/* ---------- no sticky focus on ANY button, dropdown or slider ----------
   A control that keeps focus after being clicked is wrong twice over: it LOOKS selected (the focus ring
   is indistinguishable from persistent on/off state), and it BEHAVES selected — stray Delete/Backspace/
   arrow presses get eaten by the control instead of reaching the note editor. So every mouse
   interaction hands focus back as soon as it finishes, everywhere in the app.
   Text-entry fields are deliberately excluded: the project title's swapped-in input, instrument-row
   renames, #bpmInput and the modal fields are things the user is actively typing into, and blurring
   those mid-edit would commit/close them under the cursor. */
document.addEventListener("mouseup",(e)=>{
  const el = e.target && e.target.closest ? e.target.closest("button, input[type=range]") : null;
  if(el) el.blur();
});
// <select> can't join the mouseup rule: blurring while its native popup is open dismisses the popup
// before a value can be picked. It hands focus back on the two signals that mean "the popup is done"
// instead — the value being committed (change), and the next mousedown anywhere else, which is the
// only signal a popup dismissed WITHOUT a change ever gives us. That second case matters because the
// piano roll calls preventDefault() on mousedown, which suppresses the browser's own focus change.
let selectTouchedByMouse = false;
document.addEventListener("mousedown",(e)=>{
  const active = document.activeElement;
  if(active && active.tagName==="SELECT" && active!==e.target) active.blur();
  selectTouchedByMouse = !!(e.target && e.target.tagName==="SELECT");
}, true);
// a keyboard user arrowing through a focused select must keep it — Firefox fires "change" on every
// arrow press, so the blur-on-change below only applies to a select the MOUSE opened
document.addEventListener("keydown",()=>{ selectTouchedByMouse = false; }, true);
document.addEventListener("change",(e)=>{
  if(e.target.tagName==="SELECT" && selectTouchedByMouse){ selectTouchedByMouse = false; e.target.blur(); }
});
// drops keyboard focus from a clicked button/dropdown/slider on demand (never from a text field being
// edited) — used by the selection paths below, where the same "the control isn't what's selected
// anymore" rule has to fire without waiting for the next mouseup
function blurFocusedControl(){
  const el = document.activeElement;
  if(!el || el===document.body) return;
  const tag = el.tagName;
  if(tag==="BUTTON" || tag==="SELECT" || (tag==="INPUT" && el.type==="range")) el.blur();
}

function showTooltip(x,y,text){
  const tip = document.getElementById("dragTooltip");
  tip.style.display="block"; tip.style.left=(x+14)+"px"; tip.style.top=(y+14)+"px"; tip.textContent=text;
}
function hideTooltip(){ document.getElementById("dragTooltip").style.display="none"; }

document.addEventListener("keydown", (e)=>{
  const activeEl = document.activeElement;
  const tag = activeEl.tagName;
  const isTextEntry = tag==="SELECT" || tag==="TEXTAREA" || (tag==="INPUT" && activeEl.type!=="range");
  if(isTextEntry) return;

  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="z"){
    e.preventDefault();
    if(e.shiftKey) redo(); else undo();
    return;
  }
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="y"){
    e.preventDefault(); redo(); return;
  }

  if(editContext==="track" && (e.ctrlKey||e.metaKey) && (e.key.toLowerCase()==="c"||e.key.toLowerCase()==="v"||e.key.toLowerCase()==="x")){
    const track = selectedTrack();
    const k = e.key.toLowerCase();
    if(k==="c" || k==="x"){
      if(!track) return;
      state.trackClipboard = {
        name:track.name, color:track.color, instrument:Object.assign({},track.instrument),
        volume:track.volume, notes: track.notes.map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null,bendStartStep:n.bendStartStep??0,bendEndStep:n.bendEndStep??null})),
        regions: track.regions ? track.regions.map(r=>({start:r.start,end:r.end})) : null
      };
      if(k==="x"){
        pushHistory();
        state.tracks = state.tracks.filter(t=>t.id!==track.id);
        state.selectedTrackId = state.tracks.length? state.tracks[0].id : null;
        renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); buildTrackList();
        toast("Cut track \""+track.name+"\"");
      } else {
        toast("Copied track \""+track.name+"\"");
      }
    } else {
      if(!state.trackClipboard) return;
      if(pasteOnCooldown()){ e.preventDefault(); return; }
      pushHistory();
      const c = state.trackClipboard;
      const newTrack = makeTrack(c.name+" copy", state.tracks.length);
      newTrack.instrument = Object.assign({}, c.instrument);
      newTrack.volume = c.volume;
      newTrack.notes = c.notes.map(n=>({...n, id: nextNoteId++}));
      newTrack.regions = c.regions ? c.regions.map(r=>({id: nextNoteId++, start:r.start, end:r.end})) : null;
      buildChain(newTrack);
      state.tracks.push(newTrack);
      selectTrack(newTrack.id);
      recomputeStepsTotal();
      toast("Pasted track \""+newTrack.name+"\"");
    }
    e.preventDefault();
    return;
  }

  // automation dots delete the same way notes/tracks do — checked independently of the note-selection
  // track below, since the advanced editor's target track need not be the currently selected one
  if((e.key==="Delete"||e.key==="Backspace") && state.advancedTrackId!=null && selectedAutoPointIds.size){
    const advT = advTrack();
    if(advT){
      pushHistory();
      const points = advT.automation[state.advancedParam];
      advT.automation[state.advancedParam] = points.filter(p=>!selectedAutoPointIds.has(p.id));
      selectedAutoPointIds.clear();
      renderAdvancedEditor();
      e.preventDefault();
      return;
    }
  }

  const track = selectedTrack(); if(!track) return;

  if(editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="c"){
    state.clipboard = track.notes.filter(n=>selectedNoteIds.has(n.id)).map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null,bendStartStep:n.bendStartStep??0,bendEndStep:n.bendEndStep??null}));
    if(state.clipboard.length) toast("Copied "+state.clipboard.length+" note(s)");
    e.preventDefault();
  } else if(editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="x"){
    if(!selectedNoteIds.size) return;
    pushHistory();
    state.clipboard = track.notes.filter(n=>selectedNoteIds.has(n.id)).map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null,bendStartStep:n.bendStartStep??0,bendEndStep:n.bendEndStep??null}));
    track.notes = track.notes.filter(n=>!selectedNoteIds.has(n.id));
    selectedNoteIds.clear();
    renderNotes(); buildTrackList();
    toast("Cut "+state.clipboard.length+" note(s)");
    e.preventDefault();
  } else if(editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="v"){
    if(!state.clipboard.length) return;
    if(pasteOnCooldown()){ e.preventDefault(); return; }
    pushHistory();
    const minStep = Math.min(...state.clipboard.map(n=>n.step));
    // if the current selection is still on this track (e.g. right after a copy, or after a prior
    // paste made the pasted notes the selection), anchor the new paste immediately to its right so
    // repeated Ctrl+V walks a copy rightward instead of always landing back at the playhead
    const selectedOnTrack = track.notes.filter(n=>selectedNoteIds.has(n.id));
    const pasteAt = selectedOnTrack.length
      ? Math.max(...selectedOnTrack.map(n=>n.step+n.dur))
      : Math.round(currentPlayStep());
    const newIds = [];
    state.clipboard.forEach(n=>{
      const id = nextNoteId++;
      const newNote = {id, step: pasteAt+(n.step-minStep), pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null, bendStartStep:n.bendStartStep??0, bendEndStep:n.bendEndStep??null};
      track.notes.push(newNote);
      extendRegionsForNote(track, newNote);
      newIds.push(id);
    });
    // the pasted notes are the new selection, and — like any other way notes become selected — that
    // wins over any region/automation-dot/phantom selection that was still showing
    selectNotesExclusively(newIds);
    renderNotes(); buildTrackList(); recomputeStepsTotal();
    toast("Pasted "+newIds.length+" note(s) at step "+pasteAt);
    e.preventDefault();
  } else if(e.key==="Delete" || e.key==="Backspace"){
    if(selectedNoteIds.size){
      pushHistory();
      track.notes = track.notes.filter(n=>!selectedNoteIds.has(n.id));
      selectedNoteIds.clear(); renderNotes(); buildTrackList();
      e.preventDefault();
    } else if(editContext==="track" && state.selectedTrackId!=null){
      deleteSelectedTrack();
      e.preventDefault();
    }
  } else if(e.key==="ArrowUp" && selectedNoteIds.size){
    pushHistory();
    let previewPitch = null;
    track.notes.forEach(n=>{
      if(!selectedNoteIds.has(n.id)) return;
      const p = Math.min(127,n.pitch+1), r = midiToRow(p);
      if(!track.notes.some(o=>!selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && n.step<o.step+o.dur && n.step+n.dur>o.step)){
        if(n.bendTo!=null) n.bendTo = Math.min(127, n.bendTo+1);
        n.pitch=p;
        if(previewPitch==null) previewPitch = p;
      }
    });
    if(previewPitch!=null && !state.playing) previewNote(track, previewPitch);
    renderNotes(); scrollSelectionIntoView(); e.preventDefault();
  } else if(e.key==="ArrowDown" && selectedNoteIds.size){
    pushHistory();
    let previewPitch = null;
    track.notes.forEach(n=>{
      if(!selectedNoteIds.has(n.id)) return;
      const p = Math.max(0,n.pitch-1), r = midiToRow(p);
      if(!track.notes.some(o=>!selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && n.step<o.step+o.dur && n.step+n.dur>o.step)){
        if(n.bendTo!=null) n.bendTo = Math.max(0, n.bendTo-1);
        n.pitch=p;
        if(previewPitch==null) previewPitch = p;
      }
    });
    if(previewPitch!=null && !state.playing) previewNote(track, previewPitch);
    renderNotes(); scrollSelectionIntoView(); e.preventDefault();
  } else if(e.key==="ArrowLeft" && selectedNoteIds.size){
    pushHistory();
    let previewPitch = null;
    track.notes.forEach(n=>{
      if(!selectedNoteIds.has(n.id)) return;
      const s = Math.max(0,n.step-1), r = midiToRow(n.pitch);
      if(!track.notes.some(o=>!selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && s<o.step+o.dur && s+n.dur>o.step)){
        n.step=s;
        if(previewPitch==null) previewPitch = n.pitch;
      }
    });
    if(previewPitch!=null && !state.playing) previewNote(track, previewPitch);
    renderNotes(); buildTrackList(); scrollSelectionIntoView(); e.preventDefault();
  } else if(e.key==="ArrowRight" && selectedNoteIds.size){
    pushHistory();
    let previewPitch = null;
    track.notes.forEach(n=>{
      if(!selectedNoteIds.has(n.id)) return;
      const s = n.step+1, r = midiToRow(n.pitch);
      if(!track.notes.some(o=>!selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && s<o.step+o.dur && s+n.dur>o.step)){
        n.step=s;
        if(previewPitch==null) previewPitch = n.pitch;
      }
    });
    if(previewPitch!=null && !state.playing) previewNote(track, previewPitch);
    renderNotes(); buildTrackList(); recomputeStepsTotal(); scrollSelectionIntoView(); e.preventDefault();
  } else if(phantomSelection && !selectedNoteIds.size && (e.key==="ArrowUp"||e.key==="ArrowDown"||e.key==="ArrowLeft"||e.key==="ArrowRight")){
    // phantom (empty-cell) navigation: moves the highlighted cell only, never touches track.notes —
    // no pushHistory(), since nothing about the project actually changes
    if(e.key==="ArrowUp") phantomSelection.row = Math.max(0, phantomSelection.row-1);
    else if(e.key==="ArrowDown") phantomSelection.row = Math.min(TOTAL_ROWS-1, phantomSelection.row+1);
    // still one step per press — only the rendered span follows the Note Length
    else if(e.key==="ArrowLeft") phantomSelection.step = clampPhantomStep(phantomSelection.step-1);
    else if(e.key==="ArrowRight") phantomSelection.step = clampPhantomStep(phantomSelection.step+1);
    renderNotes();
    scrollSelectionIntoView();
    e.preventDefault();
  } else if(e.code==="Space"){
    e.preventDefault();
    togglePlayPause();
  }
});

// click empty grid area (no shift) to move playhead
gridScroll.addEventListener("dblclick",(e)=>{
  if(e.target.id==="gridCanvas"){
    const {step} = xyToStepRow(e.clientX,e.clientY);
    state.playStartStep = Math.max(0,step); renderPlayheads();
  }
});
gridCanvas.addEventListener("contextmenu",(e)=>{
  e.preventDefault();
  const {step} = xyToStepRow(e.clientX,e.clientY);
  state.playStartStep = Math.max(0,step); renderPlayheads();
});

// the bigger square grip on top of the grid playhead — larger, easier target to grab and drag
document.getElementById("playheadGrip").addEventListener("mousedown",(e)=>{
  if(state.playing) stopPlayback(false);
  playheadDrag = {type:"grid"};
  e.preventDefault(); e.stopPropagation();
});

// secondary timeline pinned atop the note grid itself — click to jump the playhead there directly, or
// drag same as the flag/grip, without needing to first scroll all the way up to the arrange view
document.getElementById("gridRuler").addEventListener("mousedown",(e)=>{
  if(state.playing) stopPlayback(false);
  const rect = gridInner.getBoundingClientRect();
  state.playStartStep = Math.max(0, Math.min(STEPS_TOTAL, (e.clientX-rect.left)/STEP_W));
  playheadDrag = {type:"grid"};
  renderPlayheads();
  e.preventDefault(); e.stopPropagation();
});

/* ======================================================================
   LOOP REGION INTERACTION
   ====================================================================== */
// the loop bar/region/handles now live in the track list and get rebuilt on every buildTrackList() call,
// so listeners are delegated to the stable #trackListInner node rather than bound to the (transient) elements themselves
document.getElementById("trackListInner").addEventListener("mousedown",(e)=>{
  if(!e.target.closest("#loopBar")) return;
  const rect = document.getElementById("trackListInner").getBoundingClientRect();
  const spb = stepsPerBar();
  const x = e.clientX-rect.left;

  // the playhead flag has pointer-events:none (so it never blocks the ruler underneath it), which means
  // any click that visually lands on it actually hits #loopBar — and since the flag often sits inside
  // the loop's own region, the "move the loop" branch below used to win by default, making the flag
  // nearly impossible to grab whenever a loop was active. Grabbing the flag must always take priority.
  const phX = currentPlayStep()/spb*BAR_PX;
  if(Math.abs(x-phX)<=8){
    if(state.playing) stopPlayback(false);
    playheadDrag = {type:"trackList"};
    e.preventDefault(); e.stopPropagation();
    return;
  }

  const regionLeftPx = state.loop.start/spb*BAR_PX;
  const regionRightPx = state.loop.end/spb*BAR_PX;
  // resize handles get a forgiving pixel-tolerance hit zone around the loop's edges, rather than
  // relying on landing exactly on the thin 7px handle element
  const tolerance = 6;
  if(Math.abs(x-regionLeftPx) <= tolerance){
    loopDrag = {mode:"resizeL"};
    e.preventDefault(); e.stopPropagation(); return;
  }
  if(Math.abs(x-regionRightPx) <= tolerance){
    loopDrag = {mode:"resizeR"};
    e.preventDefault(); e.stopPropagation(); return;
  }
  if(x>regionLeftPx && x<regionRightPx){
    loopDrag = {mode:"move", downStep:x/BAR_PX*spb, startStart:state.loop.start, startEnd:state.loop.end};
    e.preventDefault(); e.stopPropagation(); return;
  }
  // Clicking the bar's empty background (not a handle, not inside the existing region) moves the
  // playhead there in ONE click and starts a drag, exactly like #trackListRuler and #gridRuler do.
  // It deliberately does NOT spin up a brand new loop region the way it once did — that made the
  // playhead flag nearly impossible to grab, since a click a few pixels off target started drawing
  // a loop instead. Loop editing stays confined to the handles and the region body (handled above).
  if(state.playing) stopPlayback(false);
  state.playStartStep = Math.max(0, Math.min(STEPS_TOTAL, x/BAR_PX*spb));
  playheadDrag = {type:"trackList"};
  renderPlayheads();
  e.preventDefault(); e.stopPropagation();
});
document.getElementById("loopBtn").addEventListener("click",()=>{
  state.loop.enabled = !state.loop.enabled;
  document.getElementById("loopBtn").classList.toggle("on", state.loop.enabled);
  renderLoopUI();
  toast(state.loop.enabled ? "Loop on (step "+state.loop.start+"–"+state.loop.end+")" : "Loop off");
});
document.getElementById("metroBtn").addEventListener("click",()=>{
  state.metronomeOn = !state.metronomeOn;
  document.getElementById("metroBtn").classList.toggle("on", state.metronomeOn);
  toast(state.metronomeOn ? "Metronome on" : "Metronome off");
});

/* ======================================================================
   ZOOM: trackpad pinch (ctrl+wheel) + the bottom-right zoom slider
   ====================================================================== */
gridScroll.addEventListener("wheel",(e)=>{
  if(!e.ctrlKey) return;
  e.preventDefault();
  setZoom(STEP_W*Math.exp(-e.deltaY*0.01));
},{passive:false});
document.getElementById("zoomSlider").addEventListener("input",(e)=>{
  setZoom(Number(e.target.value));
});
// the same gesture over the arrange view's track list, zooming BAR_PX instead of STEP_W so the
// timeline and the piano roll beneath it feel identical to pinch. Now that track blocks no longer
// have draggable edges, this (and #trackZoomSlider) is the only way to change how long a block reads.
document.getElementById("trackListCol").addEventListener("wheel",(e)=>{
  if(!e.ctrlKey) return;
  e.preventDefault();
  setTrackZoom(BAR_PX*Math.exp(-e.deltaY*0.01));
},{passive:false});

/* ======================================================================
   UNDO / REDO BUTTONS
   ====================================================================== */
document.getElementById("undoBtn").addEventListener("click", undo);
document.getElementById("redoBtn").addEventListener("click", redo);

/* ======================================================================
   INSTRUMENT LIST EVENTS (event delegation)
   ====================================================================== */
document.getElementById("instrumentList").addEventListener("click",(e)=>{
  const row = e.target.closest(".instrumentRow"); if(!row) return;
  const id = Number(row.dataset.id);
  const role = e.target.dataset.role;
  const track = state.tracks.find(t=>t.id===id);
  if(e.target.classList.contains("swatch")){ openColorPicker(track, e.target); e.stopPropagation(); return; }
  if(role==="mute"){ pushHistory(); track.muted=!track.muted; refreshAllTrackGains(); renderInstrumentList(); return; }
  if(role==="solo"){ pushHistory(); track.solo=!track.solo; refreshAllTrackGains(); renderInstrumentList(); return; }
  // The name is a plain <span data-role=nameText> until it's double-clicked. The second click of that
  // double-click is detected here (e.detail===2) rather than via a "dblclick" listener: the first
  // click selects the track, which rebuilds the whole list, and the browser only fires "dblclick"
  // when both clicks land on the *same* node — the original span is gone by then. A single click
  // behaves like clicking anywhere else on the row: it selects the track.
  if(role==="nameText"){
    if(e.detail>=2){ beginNameEdit(e.target); e.preventDefault(); return; }
    selectTrack(id);
    return;
  }
  if(!role) selectTrack(id);
});
document.getElementById("instrumentList").addEventListener("mousedown",(e)=>{
  if(e.target.dataset.role==="vol") beginHistoryGesture();
  // restore full waveform names before the popup opens, so the list never reads "S" / blank
  if(e.target.dataset.role==="wave") applyWaveTier(e.target, 0);
});
document.getElementById("instrumentList").addEventListener("focusin",(e)=>{
  if(e.target.dataset.role==="wave") applyWaveTier(e.target, 0);
});
document.getElementById("instrumentList").addEventListener("focusin",(e)=>{
  if(e.target.dataset.role==="name") beginHistoryGesture();
});
document.getElementById("instrumentList").addEventListener("focusout",(e)=>{
  if(e.target.dataset.role==="name"){ endHistoryGesture(); endNameEdit(e.target); }
  if(e.target.dataset.role==="wave") fitRowControls(e.target.closest(".instrumentRow"));
});
/* ---------- rename an instrument: double-click only ----------
   The name renders as a plain <span class="nameText"> so a single click just selects the track (and
   never lands the caret in a text field). Double-clicking it swaps in a real <input data-role=name>,
   which the existing input/focusin/focusout handlers above already drive; Enter or blur swaps the
   plain text back. The input carries its own visible border (see .instrumentRow .tname input) so the
   editable boundary is obvious while editing and invisible when not. */
function beginNameEdit(span){
  const row = span.closest(".instrumentRow"); if(!row) return;
  const track = state.tracks.find(t=>t.id===Number(row.dataset.id)); if(!track) return;
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.role = "name";
  input.value = track.name;
  span.replaceWith(input);
  sizeNameInput(input);
  fitRowControls(row);
  input.focus();
  input.select();
}
function endNameEdit(input){
  if(!input || !input.isConnected) return;
  const row = input.closest(".instrumentRow");
  const span = document.createElement("span");
  span.className = "nameText";
  span.dataset.role = "nameText";
  span.title = "Double-click to rename";
  span.textContent = input.value;
  input.replaceWith(span);
  sizeNameInput(span);
  fitRowControls(row);
}
document.getElementById("instrumentList").addEventListener("dblclick",(e)=>{
  // the double-click's own FIRST click already selected the track, which rebuilt the whole list —
  // so the element the two clicks share (this event's target) may be an ancestor of the name rather
  // than the name itself. Resolve what's actually under the cursor now instead of trusting e.target.
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const span = (under && under.closest('[data-role=nameText]'))
            || (e.target.closest && e.target.closest('[data-role=nameText]'));
  if(!span) return;
  beginNameEdit(span);
  e.preventDefault(); e.stopPropagation();
});
document.getElementById("instrumentList").addEventListener("keydown",(e)=>{
  if(e.target.dataset.role!=="name") return;
  if(e.key==="Enter" || e.key==="Escape"){
    const input = e.target;
    input.blur();
    // don't wait on focusout alone: exiting edit mode is the point of the keypress, and endNameEdit
    // no-ops if the blur already swapped the input out
    endNameEdit(input);
    e.preventDefault(); e.stopPropagation();
  }
});
document.getElementById("instrumentList").addEventListener("input",(e)=>{
  const row = e.target.closest(".instrumentRow"); if(!row) return;
  const id = Number(row.dataset.id);
  const track = state.tracks.find(t=>t.id===id);
  const role = e.target.dataset.role;
  if(role==="name"){
    track.name = e.target.value; sizeNameInput(e.target); fitRowControls(row); buildTrackList();
    if(track.id===state.selectedTrackId) document.getElementById("instTrackName").textContent=track.name;
  }
  if(role==="vol"){ track.volume = e.target.value/100; refreshAllTrackGains(); if(track.id===state.selectedTrackId) refreshInstrumentEditor(); if(track.id===state.advancedTrackId) renderAdvancedEditor(); }
  if(role==="wave"){ pushHistory(); applyWaveSelection(track.instrument, e.target.value); fitRowControls(row); if(track.id===state.selectedTrackId) refreshInstrumentEditor(); }
});

/* ======================================================================
   TRACK COLOR PICKER (palette dropdown + bespoke hue/saturation custom picker)
   ====================================================================== */
function hsvToRgb(h,s,v){
  h = ((h%360)+360)%360;
  const c = v*s, x = c*(1-Math.abs((h/60)%2-1)), m = v-c;
  let r,g,b;
  if(h<60){ r=c;g=x;b=0; } else if(h<120){ r=x;g=c;b=0; } else if(h<180){ r=0;g=c;b=x; }
  else if(h<240){ r=0;g=x;b=c; } else if(h<300){ r=x;g=0;b=c; } else { r=c;g=0;b=x; }
  return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
}
function rgbToHex(r,g,b){ return "#"+[r,g,b].map(v=>v.toString(16).padStart(2,"0")).join(""); }
function hexToRgb(hex){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1],16),parseInt(m[2],16),parseInt(m[3],16)] : [255,255,255];
}
function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if(d!==0){
    if(max===r) h=60*(((g-b)/d)%6);
    else if(max===g) h=60*((b-r)/d+2);
    else h=60*((r-g)/d+4);
  }
  if(h<0) h+=360;
  const s = max===0?0:d/max, v = max;
  return [h,s,v];
}

let colorPickerTrack = null;
let colorCustomHsv = [140,0.6,0.8];
function closeColorPicker(){
  colorPickerTrack = null;
  document.getElementById("colorPicker").classList.add("hidden");
  document.getElementById("colorCustomPanel").classList.add("hidden");
}
function openColorPicker(track, anchorEl){
  colorPickerTrack = track;
  const picker = document.getElementById("colorPicker");
  const palette = document.getElementById("colorPalette");
  palette.innerHTML = "";
  TRACK_COLORS.forEach(color=>{
    const b = document.createElement("button");
    b.className = "colorSwatchBtn"; b.style.background = color; b.title = color;
    b.addEventListener("click",()=>{
      if(!colorPickerTrack) return;
      pushHistory();
      colorPickerTrack.color = color;
      renderInstrumentList(); buildTrackList();
      if(colorPickerTrack.id===state.advancedTrackId) renderAdvancedEditor();
      closeColorPicker();
    });
    palette.appendChild(b);
  });
  document.getElementById("colorCustomPanel").classList.add("hidden");
  colorCustomHsv = rgbToHsv(...hexToRgb(track.color));
  drawColorHueCanvas();
  drawColorSVCanvas();
  positionColorDots();
  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = Math.round(rect.left)+"px";
  picker.style.top = Math.round(rect.bottom+6)+"px";
  picker.classList.remove("hidden");
}
function drawColorHueCanvas(){
  const canvas = document.getElementById("colorHueCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const grad = ctx.createLinearGradient(0,0,w,0);
  for(let i=0;i<=6;i++) grad.addColorStop(i/6, rgbToHex(...hsvToRgb(i*60,1,1)));
  ctx.fillStyle = grad; ctx.fillRect(0,0,w,h);
}
function drawColorSVCanvas(){
  const canvas = document.getElementById("colorSVCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const hueColor = rgbToHex(...hsvToRgb(colorCustomHsv[0],1,1));
  ctx.fillStyle = hueColor; ctx.fillRect(0,0,w,h);
  const whiteGrad = ctx.createLinearGradient(0,0,w,0);
  whiteGrad.addColorStop(0,"rgba(255,255,255,1)"); whiteGrad.addColorStop(1,"rgba(255,255,255,0)");
  ctx.fillStyle = whiteGrad; ctx.fillRect(0,0,w,h);
  const blackGrad = ctx.createLinearGradient(0,0,0,h);
  blackGrad.addColorStop(0,"rgba(0,0,0,0)"); blackGrad.addColorStop(1,"rgba(0,0,0,1)");
  ctx.fillStyle = blackGrad; ctx.fillRect(0,0,w,h);
}
function positionColorDots(){
  const [h,s,v] = colorCustomHsv;
  const svCanvas = document.getElementById("colorSVCanvas");
  document.getElementById("colorSVDot").style.left = (s*svCanvas.clientWidth)+"px";
  document.getElementById("colorSVDot").style.top = ((1-v)*svCanvas.clientHeight)+"px";
  const hueCanvas = document.getElementById("colorHueCanvas");
  document.getElementById("colorHueDot").style.left = ((h/360)*hueCanvas.clientWidth)+"px";
}
function applyCustomColor(commit){
  if(!colorPickerTrack) return;
  const [r,g,b] = hsvToRgb(...colorCustomHsv);
  const hex = rgbToHex(r,g,b);
  colorPickerTrack.color = hex;
  renderInstrumentList(); buildTrackList();
  if(colorPickerTrack.id===state.advancedTrackId) renderAdvancedEditor();
}
document.getElementById("colorCustomBtn").addEventListener("click",()=>{
  document.getElementById("colorCustomPanel").classList.toggle("hidden");
  drawColorHueCanvas(); drawColorSVCanvas(); positionColorDots();
});
let colorDrag = null; // {type:'sv'|'hue'}
document.getElementById("colorSVWrap").addEventListener("mousedown",(e)=>{
  if(!colorPickerTrack) return;
  beginHistoryGesture();
  colorDrag = {type:"sv"};
  updateColorFromEvent(e);
  e.preventDefault();
});
document.getElementById("colorHueWrap").addEventListener("mousedown",(e)=>{
  if(!colorPickerTrack) return;
  beginHistoryGesture();
  colorDrag = {type:"hue"};
  updateColorFromEvent(e);
  e.preventDefault();
});
function updateColorFromEvent(e){
  if(!colorDrag || !colorPickerTrack) return;
  if(colorDrag.type==="sv"){
    const rect = document.getElementById("colorSVCanvas").getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (e.clientX-rect.left)/rect.width));
    const v = 1 - Math.max(0, Math.min(1, (e.clientY-rect.top)/rect.height));
    colorCustomHsv[1] = s; colorCustomHsv[2] = v;
  } else {
    const rect = document.getElementById("colorHueCanvas").getBoundingClientRect();
    const h = Math.max(0, Math.min(360, (e.clientX-rect.left)/rect.width*360));
    colorCustomHsv[0] = h;
    drawColorSVCanvas();
  }
  positionColorDots();
  applyCustomColor();
}
window.addEventListener("mousemove",(e)=>{ if(colorDrag) updateColorFromEvent(e); });
window.addEventListener("mouseup",()=>{ colorDrag = null; });
document.addEventListener("mousedown",(e)=>{
  const picker = document.getElementById("colorPicker");
  if(picker.classList.contains("hidden")) return;
  if(e.target.closest("#colorPicker") || e.target.classList.contains("swatch")) return;
  closeColorPicker();
});

document.getElementById("trackListInner").addEventListener("click",(e)=>{
  if(suppressTrackListClick){ suppressTrackListClick=false; return; }
  const row = e.target.closest(".trackRow"); if(!row) return;
  selectTrack(Number(row.dataset.id), {scrollToFirstNote:true});
});
document.getElementById("trackListCol").addEventListener("mousedown",(e)=>{
  if(e.target.closest("#trackListRuler")){
    if(state.playing) stopPlayback(false);
    const rect = document.getElementById("trackListInner").getBoundingClientRect();
    state.playStartStep = Math.max(0, Math.min(STEPS_TOTAL, (e.clientX-rect.left)/BAR_PX*stepsPerBar()));
    playheadDrag = {type:"trackList"};
    renderPlayheads();
    e.preventDefault(); e.stopPropagation();
    return;
  }
  const blockEl = e.target.closest(".trackBlock");
  if(blockEl){
    const rowEl = e.target.closest(".trackRow");
    const trackId = Number(rowEl.dataset.id);
    const track = state.tracks.find(t=>t.id===trackId);
    if(!track) return;
    const regionId = blockEl.dataset.regionId!=null ? Number(blockEl.dataset.regionId) : null;

    if(e.shiftKey && regionId!=null){
      // shift-click toggles this region into/out of the multi-selection, without starting a drag
      if(selectedRegionIds.has(regionId)) selectedRegionIds.delete(regionId);
      else selectedRegionIds.add(regionId);
      buildTrackList();
      e.preventDefault(); e.stopPropagation();
      return;
    }
    selectedRegionIds = regionId!=null ? new Set([regionId]) : new Set();

    // clicking directly on a block rebuilds the track-list DOM synchronously (via selectTrack -> buildTrackList),
    // which means the native "click" event never fires afterward — so the scroll-to-first-note has to happen here
    selectTrack(trackId, {scrollToFirstNote:true});
    pushHistory();
    document.body.style.cursor = "grabbing";
    if(regionId!=null){
      // dragging one split-off region: only its own notes move, clamped so it can't cross into a neighboring region
      const idx = track.regions.findIndex(r=>r.id===regionId);
      const region = track.regions[idx];
      const prevRegion = track.regions[idx-1], nextRegion = track.regions[idx+1];
      const minDelta = (prevRegion? prevRegion.end : 0) - region.start;
      const maxDelta = nextRegion? (nextRegion.start - region.end) : Infinity;
      trackDrag = {
        trackId, startX:e.clientX, minDelta, maxDelta,
        origin: track.notes.filter(n=> n.step>=region.start && n.step<region.end).map(n=>({id:n.id, step:n.step})),
        originRegions: [{id:region.id, start:region.start, end:region.end}]
      };
    } else {
      // un-split track: the whole thing (all notes) drags together, as before
      trackDrag = {
        trackId, startX:e.clientX, minDelta:-Infinity, maxDelta:Infinity,
        origin: track.notes.map(n=>({id:n.id, step:n.step})),
        originRegions: track.regions ? track.regions.map(r=>({id:r.id, start:r.start, end:r.end})) : null
      };
    }
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if(selectedRegionIds.size){ selectedRegionIds.clear(); buildTrackList(); }
  const rect = document.getElementById("trackListInner").getBoundingClientRect();
  const x = e.clientX-rect.left;
  const phX = currentPlayStep()/stepsPerBar()*BAR_PX;
  if(Math.abs(x-phX)<=8){
    if(state.playing) stopPlayback(false);
    playheadDrag = {type:"trackList"};
    e.preventDefault(); e.stopPropagation();
  }
});

// keep the instrument list and the track list scrolling together vertically
const instrumentListScrollEl = document.getElementById("instrumentListScroll");
const trackListCol = document.getElementById("trackListCol");
let syncingArrangeScroll = false;
instrumentListScrollEl.addEventListener("scroll", ()=>{
  if(syncingArrangeScroll) return;
  syncingArrangeScroll = true;
  trackListCol.scrollTop = instrumentListScrollEl.scrollTop;
  syncingArrangeScroll = false;
  positionTrackListFlag();
});
trackListCol.addEventListener("scroll", ()=>{
  if(syncingArrangeScroll) return;
  syncingArrangeScroll = true;
  instrumentListScrollEl.scrollTop = trackListCol.scrollTop;
  syncingArrangeScroll = false;
  positionTrackListFlag();
});
document.getElementById("trackListCol").addEventListener("dblclick",(e)=>{
  const rect = document.getElementById("trackListInner").getBoundingClientRect();
  const x = e.clientX-rect.left;
  const step = Math.round(x/BAR_PX*stepsPerBar());
  state.playStartStep = Math.max(0,step); renderPlayheads();
  // scroll grid to same position
  gridScroll.scrollLeft = step*STEP_W-100;
});

document.getElementById("instrumentRowHeightSlider").addEventListener("input",(e)=> setTrackRowHeight(Number(e.target.value)));
document.getElementById("trackZoomSlider").addEventListener("input",(e)=> setTrackZoom(Number(e.target.value)));

document.getElementById("addTrackBtnTop").addEventListener("click", addTrack);
document.getElementById("deleteTrackBtn").addEventListener("click", deleteSelectedTrack);
document.getElementById("splitBtn").addEventListener("click", ()=>{
  const track = selectedTrack(); if(!track) return;
  if(!track.notes.length){ toast("\""+track.name+"\" has no notes to split"); return; }
  const splitStep = Math.round(currentPlayStep());
  const spb = stepsPerBar();
  pushHistory();
  // first split ever on this track: establish its single region from the current note span
  if(!track.regions || !track.regions.length){
    const minStep = Math.min(...track.notes.map(n=>n.step));
    const maxStep = Math.max(...track.notes.map(n=>n.step+n.dur));
    track.regions = [{id: nextNoteId++, start: Math.floor(minStep/spb)*spb, end: Math.ceil(maxStep/spb)*spb}];
  }
  const idx = track.regions.findIndex(r=> splitStep>r.start && splitStep<r.end);
  if(idx===-1){
    undoStack.pop(); // nothing actually changed — drop the checkpoint we just pushed
    toast("Playhead must be inside a region of \""+track.name+"\" to split it");
    return;
  }
  const region = track.regions[idx];
  const left = {id: nextNoteId++, start:region.start, end:splitStep};
  const right = {id: nextNoteId++, start:splitStep, end:region.end};
  track.regions.splice(idx, 1, left, right);
  renderInstrumentList(); buildTrackList(); renderNotes();
  toast("Split \""+track.name+"\" at step "+splitStep);
});

/* ======================================================================
   INSTRUMENT EDITOR EVENTS
   ====================================================================== */
function bindSlider(id, cb){
  const el = document.getElementById(id);
  el.addEventListener("mousedown", beginHistoryGesture);
  el.addEventListener("input",(e)=>{ cb(Number(e.target.value)); });
}
document.getElementById("waveSel").addEventListener("change",(e)=>{
  const t=selectedTrack(); if(!t) return; pushHistory();
  applyWaveSelection(t.instrument, e.target.value);
  renderInstrumentList(); refreshInstrumentEditor();
});
bindSlider("volSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.volume=v/100; document.getElementById("volVal").textContent=v; refreshAllTrackGains(); renderInstrumentList(); renderAdvancedEditor(); });
bindSlider("atkSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.attack=v; document.getElementById("atkVal").textContent=v+"ms"; });
bindSlider("relSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.release=v; document.getElementById("relVal").textContent=v+"ms"; });
bindSlider("eqLowSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.eqLow=v; document.getElementById("eqLowVal").textContent=v+"dB"; applyInstrumentToChain(t); renderAdvancedEditor(); });
bindSlider("eqMidSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.eqMid=v; document.getElementById("eqMidVal").textContent=v+"dB"; applyInstrumentToChain(t); renderAdvancedEditor(); });
bindSlider("eqHighSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.eqHigh=v; document.getElementById("eqHighVal").textContent=v+"dB"; applyInstrumentToChain(t); renderAdvancedEditor(); });
bindSlider("revSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.reverb=v; document.getElementById("revVal").textContent=v+"%"; applyInstrumentToChain(t); renderAdvancedEditor(); });

document.getElementById("transUpBtn").addEventListener("click",()=>{
  const t=selectedTrack(); if(!t)return; pushHistory();
  t.notes.forEach(n=>{ n.pitch=Math.min(127,n.pitch+1); if(n.bendTo!=null) n.bendTo=Math.min(127,n.bendTo+1); });
  renderNotes(); toast("Transposed "+t.name+" up 1 semitone");
});
document.getElementById("transDownBtn").addEventListener("click",()=>{
  const t=selectedTrack(); if(!t)return; pushHistory();
  t.notes.forEach(n=>{ n.pitch=Math.max(0,n.pitch-1); if(n.bendTo!=null) n.bendTo=Math.max(0,n.bendTo-1); });
  renderNotes(); toast("Transposed "+t.name+" down 1 semitone");
});

document.getElementById("uploadSampleBtn").addEventListener("click",()=>{
  if(!selectedTrack()){ toast("Select a track first"); return; }
  document.getElementById("sampleInput").click();
});
document.getElementById("sampleInput").addEventListener("change",(e)=>{
  const file = e.target.files[0]; if(!file) return;
  const track = selectedTrack(); if(!track) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    actx.decodeAudioData(reader.result.slice(0), (buf)=>{
      // the upload joins the PROJECT's registry first and is then bound to the track that asked for it,
      // so every other track's waveform dropdown gains it as a choice too
      const entry = registerSample(file.name, buf);
      applySampleToTrack(track, entry);
      renderSamplePanel();
      renderInstrumentList();
      refreshInstrumentEditor(); // rebuilds #waveSel's options and reveals #sampleMenuBtn on the first upload
      toast("Loaded sample: "+entry.name);
    }, (err)=>{ toast("Could not decode audio file"); });
  };
  reader.readAsArrayBuffer(file);
  e.target.value="";
});

/* ======================================================================
   HEADER CONTROL EVENTS
   ====================================================================== */
document.getElementById("bpmInput").addEventListener("change",(e)=>{ state.bpm = Math.max(30,Math.min(300,Number(e.target.value)||120)); });
document.getElementById("timeSigSel").addEventListener("change",(e)=>{
  const [a,b] = e.target.value.split("/").map(Number); state.timeSig=[a,b]; drawGridLines(); drawGridRuler(); buildTrackList();
});
/* ---------- retype the selected notes, keeping their SPACING ----------
   Changing the note type of a selection re-types every selected note to `newDur` and then re-lays the
   run out so the GAPS between consecutive notes are exactly what they were — the gap is the invariant,
   not the absolute positions. Turning a run of quarters into sixteenths therefore compacts it (and
   turning them back stretches it out again) while the rhythm's proportions survive intact.
   Pitch is deliberately ignored: the selection is treated as one time-ordered run even when it walks up
   a scale across rows, which is exactly the case this was asked for. */
function retypeSelectedNotes(track, newDur){
  const sel = track.notes.filter(n=>selectedNoteIds.has(n.id)).sort((a,b)=>a.step-b.step);
  if(!sel.length) return;
  pushHistory();
  // notes that START on the same step are a chord: they are laid out as ONE group so they keep sharing
  // a step instead of being strung out into an arpeggio by the re-spacing
  const groups = [];
  sel.forEach(n=>{
    const last = groups[groups.length-1];
    if(last && last.step===n.step) last.notes.push(n);
    else groups.push({step:n.step, notes:[n]});
  });
  // gap[i] = empty space between group i's end and group i+1's start, measured with the ORIGINAL
  // durations (a group's end is its longest note's end). Notes that overlapped would give a negative
  // gap; those are clamped to 0 rather than preserved, so a retype can never deepen an overlap into a
  // pile of stacked tiles — back-to-back (gap 0) is the tightest result the re-spacing will produce.
  const gaps = [];
  for(let i=0;i<groups.length-1;i++){
    const end = Math.max.apply(null, groups[i].notes.map(n=>n.step+n.dur));
    gaps.push(Math.max(0, groups[i+1].step - end));
  }
  // the first group stays anchored on its existing step; every later group starts one newDur plus its
  // own original gap further along. Nothing may end up negative or past the end of the grid — the span
  // can grow, which is what the recomputeStepsTotal() below is for.
  let cursor = Math.max(0, Math.min(groups[0].step, STEPS_TOTAL-newDur));
  groups.forEach((g,i)=>{
    g.notes.forEach(n=>{
      n.step = cursor;
      n.dur = newDur;
      // a slur's start/end offsets are measured in steps from the note's own left edge, so shortening
      // the tile has to pull them back in or the slide would be drawn hanging off the end of it
      if(n.bendEndStep!=null) n.bendEndStep = Math.min(n.bendEndStep, newDur);
      if(n.bendStartStep) n.bendStartStep = Math.min(n.bendStartStep, Math.max(0, newDur-0.15));
      extendRegionsForNote(track, n);
    });
    if(i<groups.length-1) cursor = Math.max(0, Math.min(STEPS_TOTAL-newDur, cursor + newDur + gaps[i]));
  });
  // unselected notes are deliberately NOT consulted for collisions here: clamping a length or a step
  // against a neighbouring tile would silently break the one thing this operation promises to keep
  renderNotes(); buildTrackList(); recomputeStepsTotal();
}

document.getElementById("noteLenSel").addEventListener("change",(e)=>{
  state.noteLenSteps = Number(e.target.value);
  // with notes selected the dropdown acts as a property editor on THEM — it re-types the selection and
  // re-spaces it (below) instead of only deciding what the next placed note will look like
  const track = selectedTrack();
  if(track && selectedNoteIds.size){ retypeSelectedNotes(track, state.noteLenSteps); return; }
  // the ghost cell spans the note length, so a live change resizes it (and may push its right edge
  // past the grid end or out of view) — re-clamp, redraw and re-check scroll
  if(phantomSelection){
    phantomSelection.step = clampPhantomStep(phantomSelection.step);
    renderNotes();
    scrollSelectionIntoView();
  }
});
document.getElementById("keySel").addEventListener("change",(e)=>{ state.key=e.target.value; buildPianoLabels(); drawGridLines(); });
document.getElementById("modeSel").addEventListener("change",(e)=>{
  const prevMode = state.mode;      // read BEFORE state.mode is overwritten below — the degree mapping
  const nextMode = e.target.value;  // needs both ends of the switch to know where each note is going
  // the two trivial no-ops (re-picking the mode that is already set, or a project with nothing in it)
  // short-circuit ahead of pushHistory(), so they cannot clear the redo stack either
  const anyNotes = state.tracks.some(t=>t.notes.length>0);
  let moved = 0;
  if(prevMode!==nextMode && anyNotes){
    // one checkpoint for the WHOLE sweep, taken before anything moves, so a single Ctrl+Z puts every
    // note back at once rather than unwinding the transposition note by note
    pushHistory();
    moved = transposeProjectToMode(prevMode, nextMode);
    // same idiom as #splitBtn: the mapping can legitimately move nothing (switching to Chromatic, or a
    // part that only uses degrees the two modes agree on), and a checkpoint identical to the state it
    // was taken from is just clutter on the undo stack
    if(!moved) undoStack.pop();
  }
  state.mode=nextMode;
  buildPianoLabels(); drawGridLines();
  // only redraw the tiles when pitches actually moved; the track list shows the same notes in miniature
  if(moved){
    renderNotes(); buildTrackList();
    toast("Transposed "+moved+" note"+(moved===1?"":"s")+" from "+prevMode+" to "+nextMode);
  }
});
document.getElementById("octaveSel").addEventListener("change",(e)=>{
  state.octaveFocus = Number(e.target.value);
  const midi=(state.octaveFocus+1)*12;
  gridScroll.scrollTop = midiToRow(midi)*ROW_H+GRID_RULER_H - gridScroll.clientHeight/2;
  syncPianoScroll();
});

/* ---------- project title (sub-header): plain text, editable on double-click ----------
   Mirrors how instrument names behave in the instrument list: no border while displaying, a bordered
   input while editing, committed on Enter/blur. state.projectTitle is what serializeProject() writes
   and what the Save dialog prefills its own (still editable) title field from. */
function renderProjectTitle(){
  const span = document.getElementById("projectTitle");
  if(span) span.textContent = state.projectTitle || "Bit Beats Project";
  syncSubHeaderLayout();
}

/* ---------- sub-header horizontal alignment ----------
   The sub-header's first control (the BPM field) is meant to line up under #playBtn in the header row,
   with a fixed clear run of space after the project title. Those two wants fight each other as soon as
   the title gets long, so the resting x is:

       bpmX = clamp(titleRight + SUBHEADER_TITLE_GAP_PX, playBtnX, INSTRUMENT_LIST_DEFAULT_W)

   i.e. the title's required gap pushes the whole group right, never left of #playBtn, and never past
   the instrument-list divider; past that the title truncates with its own ellipsis instead.
   The clamp deliberately uses the CONSTANT 230, not #instrumentListCol's live width: dragging
   #vResizerInstrumentList must not twitch the sub-header buttons, so the two are only ever visually
   related at the column's default size.

   On the gap's SIZE: "BPM sits under #playBtn by default" and "the title always keeps a fixed gap"
   can only both be true if that gap is no wider than the room the default title actually leaves —
   "Bit Beats Project" ends ~119px into the content box and #playBtn starts ~127px in, so anything
   above ~8 pushes the group off the play button before the user has typed a thing. 8 is therefore the
   value that satisfies both rules at rest; raise it and the default title starts shoving the group
   right (the layout still behaves, the alignment just stops being the resting state). */
const SUBHEADER_TITLE_GAP_PX = 8;         // clear space demanded between #projectTitle's right edge and the BPM field
const INSTRUMENT_LIST_DEFAULT_W = 230;    // must match #instrumentListCol's default width in style.css
function syncSubHeaderLayout(){
  const sub = document.getElementById("subHeader");
  const wrap = document.getElementById("projectTitleWrap");
  const title = document.getElementById("projectTitle");
  const play = document.getElementById("playBtn");
  const group = sub && sub.querySelector(".hgroup");
  // while the title is being renamed the span is swapped out for an <input> (beginProjectTitleEdit),
  // which sizes itself — leave the layout exactly as it was until the edit commits
  if(!sub || !wrap || !title || !play || !group) return;

  const subCS = getComputedStyle(sub);
  // #subHeader / #header both carry side padding, so the viewport x of the sub-header's CONTENT box is
  // what the title and the flex gaps are actually measured from
  const contentLeft = sub.getBoundingClientRect().left + (parseFloat(subCS.paddingLeft)||0);
  const flexGap = parseFloat(subCS.columnGap) || 0;
  const groupPadLeft = parseFloat(getComputedStyle(group).paddingLeft) || 0;

  // Natural (uncapped) width the title box wants. Measured by briefly dropping BOTH caps this function
  // assigned last pass and reading the browser's own layout, rather than by running the text through
  // measureTextPx: the canvas fallback disagrees with real text layout by ~10px on this font stack
  // (-apple-system does not resolve inside a canvas font string), and an over-estimate here is not
  // harmless — it reserves room the title never uses, which at a small gap is enough to ellipsise a
  // title that actually fits. Costs one forced reflow, on title edits and window resizes only.
  const prevMax = title.style.maxWidth, prevWrapW = wrap.style.width, prevMargin = wrap.style.marginRight;
  title.style.maxWidth = "none"; wrap.style.width = "auto"; wrap.style.marginRight = "0px";
  const naturalW = title.getBoundingClientRect().width;
  title.style.maxWidth = prevMax; wrap.style.width = prevWrapW; wrap.style.marginRight = prevMargin;

  // Space that exists between the title's right edge and the BPM field no matter what anyone asks for:
  // the wrap's own padding, then the sub-header's flex gap, then the group's left padding. It is NOT
  // subtracted from the title's room (that is what was clipping it) — it is cancelled out by the
  // margin below, so SUBHEADER_TITLE_GAP_PX means the rendered clear space and nothing else.
  const wrapCS = getComputedStyle(wrap);
  const structuralGap = (parseFloat(wrapCS.paddingLeft)||0) + (parseFloat(wrapCS.paddingRight)||0)
                      + flexGap + groupPadLeft;
  const wrapPadX = (parseFloat(wrapCS.paddingLeft)||0) + (parseFloat(wrapCS.paddingRight)||0);

  // The title grows freely until the clamp: past it the title is what gives way, not the group's x.
  const defaultX = play.getBoundingClientRect().left;
  const maxTitleW = Math.max(40, INSTRUMENT_LIST_DEFAULT_W - contentLeft - SUBHEADER_TITLE_GAP_PX);
  const titleW = Math.min(naturalW, maxTitleW);
  const bpmX = Math.max(defaultX, contentLeft + titleW + SUBHEADER_TITLE_GAP_PX);

  // the spare pixel is handed out only while the title already fits, where it cannot move the rendered
  // right edge; once the cap is doing real truncation the room is exact
  title.style.maxWidth = (naturalW <= titleW ? titleW+1 : titleW) + "px";
  wrap.style.width = (titleW + wrapPadX) + "px";
  // ...and the group is placed by margin rather than by inflating the wrap, so the title always gets its
  // full titleW of room. The margin goes NEGATIVE whenever the requested gap is tighter than the
  // structural one (which is what lets an 8px gap exist at all beside a 14px flex gap), and positive to
  // push the group out to #playBtn's x when a short title leaves slack.
  wrap.style.marginRight = (bpmX - contentLeft - titleW - structuralGap) + "px";
}
function beginProjectTitleEdit(){
  const wrap = document.getElementById("projectTitleWrap");
  const span = document.getElementById("projectTitle");
  if(!wrap || !span) return;
  const input = document.createElement("input");
  input.type = "text"; input.maxLength = 80; input.id = "projectTitleInput";
  input.value = state.projectTitle || "";
  const commit = ()=>{
    if(!input.isConnected) return;
    state.projectTitle = input.value.trim() || "Bit Beats Project";
    input.replaceWith(span);
    renderProjectTitle();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown",(e)=>{
    if(e.key==="Enter"){ commit(); e.preventDefault(); }
    else if(e.key==="Escape"){ input.value = state.projectTitle || ""; commit(); e.preventDefault(); }
    e.stopPropagation();
  });
  span.replaceWith(input);
  input.focus(); input.select();
}
document.getElementById("projectTitleWrap").addEventListener("click",(e)=>{
  if(e.detail>=2 && e.target.id==="projectTitle") beginProjectTitleEdit();
});
document.getElementById("projectTitleWrap").addEventListener("dblclick",(e)=>{
  if(e.target.id==="projectTitle") beginProjectTitleEdit();
});

document.getElementById("playBtn").addEventListener("click", togglePlayPause);
document.getElementById("holdPosBtn").addEventListener("click",()=>{
  state.holdPositionOnPause = !state.holdPositionOnPause;
  document.getElementById("holdPosBtn").classList.toggle("on", state.holdPositionOnPause);
  toast(state.holdPositionOnPause ? "Pause holds playhead position" : "Pause resets playhead to start");
});

function syncPianoScroll(){
  document.getElementById("pianoColInner").style.transform = "translateY("+(-gridScroll.scrollTop)+"px)";
}
gridScroll.addEventListener("scroll", syncPianoScroll);

/* ======================================================================
   SAVE / LOAD / NEW
   ====================================================================== */
function serializeProject(){
  return {
    projectTitle: state.projectTitle, bpm: state.bpm, timeSig: state.timeSig, key: state.key, mode: state.mode,
    octaveFocus: state.octaveFocus, noteLenSteps: state.noteLenSteps,
    tracks: state.tracks.map(t=>({
      id:t.id, name:t.name, color:t.color, muted:t.muted, solo:t.solo, volume:t.volume, pan:t.pan,
      instrument: { wave:t.instrument.wave, volume:t.instrument.volume, attack:t.instrument.attack,
        release:t.instrument.release, eqLow:t.instrument.eqLow, eqMid:t.instrument.eqMid,
        eqHigh:t.instrument.eqHigh, reverb:t.instrument.reverb, customBaseMidi:t.instrument.customBaseMidi,
        // the id only, never the buffer: a decoded AudioBuffer is not JSON, and shipping raw audio
        // inside a project file is out of scope. Re-opening the file in the SAME session still finds
        // its sample (the registry is alive); in a fresh one the id resolves to nothing and the track
        // falls back to the generic "Custom" option, which is what it did before samples had names.
        sampleId:t.instrument.sampleId??null },
      notes: t.notes.map(n=>({id:n.id, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null, bendStartStep:n.bendStartStep??0, bendEndStep:n.bendEndStep??null})),
      regions: t.regions ? t.regions.map(r=>({id:r.id, start:r.start, end:r.end})) : null,
      automation: cloneAutomation(t.automation)
    }))
  };
}
/* ---- export: WAV (offline render of the whole project) ---- */
function audioBufferToWavBlob(buffer){
  const numCh = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const blockAlign = numCh*2, dataSize = len*blockAlign;
  const ab = new ArrayBuffer(44+dataSize);
  const view = new DataView(ab);
  const writeStr = (offset,str)=>{ for(let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); };
  writeStr(0,"RIFF"); view.setUint32(4,36+dataSize,true); writeStr(8,"WAVE");
  writeStr(12,"fmt "); view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,numCh,true); view.setUint32(24,sr,true);
  view.setUint32(28,sr*blockAlign,true); view.setUint16(32,blockAlign,true); view.setUint16(34,16,true);
  writeStr(36,"data"); view.setUint32(40,dataSize,true);
  const channels = []; for(let c=0;c<numCh;c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for(let i=0;i<len;i++){
    for(let c=0;c<numCh;c++){
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s<0 ? s*0x8000 : s*0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([ab], {type:"audio/wav"});
}
// renders the whole project offline into a raw AudioBuffer — shared by both the WAV and MP3 export
// paths, which just encode this same buffer two different ways
// `loopCount` (default 1) renders the project back-to-back that many times. It is deliberately done
// by scheduling every note again on each pass inside ONE offline render — rather than rendering once
// and concatenating the resulting buffer — so a note's release and its reverb tail bleed across each
// seam exactly as they would in live playback. Concatenating a buffer that already contains a tail
// would duplicate that tail and leave an audible bump at every repeat.
// The repeat period is the project length rounded UP to a whole bar, so each pass starts on the beat.
async function renderProjectToAudioBuffer(loopCount){
  const repeats = Math.max(1, Math.floor(Number(loopCount)||1));
  let lastStep = stepsPerBar();
  state.tracks.forEach(t=> t.notes.forEach(n=> lastStep = Math.max(lastStep, n.step+n.dur)));
  const spb = stepsPerBar();
  const loopLenSteps = Math.max(spb, Math.ceil(lastStep/spb)*spb);
  const loopSec = loopLenSteps*stepDurSec();
  const tailSec = 1.0; // let releases/reverb ring out past the last note
  const durSec = repeats*loopSec + tailSec;
  const sr = actx.sampleRate;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(durSec*sr), sr);
  const offlineMaster = offlineCtx.createGain(); offlineMaster.gain.value = masterGain.gain.value;
  offlineMaster.connect(offlineCtx.destination);
  // reverb/noise buffers must belong to offlineCtx — buffers created against the live actx can't be
  // reused in an OfflineAudioContext's graph, so these are regenerated the same way makeReverbBuffer/
  // getNoiseBuffer do it for the live context
  const reverbBuf = (()=>{
    const rate = offlineCtx.sampleRate, rlen = rate*2.2, buf = offlineCtx.createBuffer(2,rlen,rate);
    for(let ch=0; ch<2; ch++){ const d = buf.getChannelData(ch);
      for(let i=0;i<rlen;i++){ d[i] = (Math.random()*2-1) * Math.pow(1-i/rlen, 2.5); } }
    return buf;
  })();
  const noiseBuf = (()=>{
    const len = offlineCtx.sampleRate, buf = offlineCtx.createBuffer(1,len,offlineCtx.sampleRate);
    const d = buf.getChannelData(0); for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
    return buf;
  })();
  const solo = anySolo();
  state.tracks.forEach(track=>{
    const chain = makeChain(offlineCtx, reverbBuf, offlineMaster);
    const audible = solo ? track.solo : !track.muted;
    const hasAutomation = Object.values(track.automation).some(arr=>arr && arr.length);
    if(!hasAutomation){
      chain.eqLow.gain.value = track.instrument.eqLow;
      chain.eqMid.gain.value = track.instrument.eqMid;
      chain.eqHigh.gain.value = track.instrument.eqHigh;
      const wetAmt = track.instrument.reverb/100;
      chain.dry.gain.value = 1-wetAmt*0.6; chain.wet.gain.value = wetAmt;
      chain.trackOut.gain.value = audible ? track.volume : 0;
      chain.panNode.pan.value = (track.pan-50)/50;
    } else {
      // automation moves parameters over time, so sample the drawn curves at a fixed rate across the
      // whole render and schedule them, mirroring what applyAutomationAtStep does tick-by-tick live
      const dt = 0.1;
      for(let t=0; t<=durSec; t+=dt){
        // automation replays from the top on every repeat, same as the notes do
        const step = (t % loopSec)/stepDurSec();
        const vol = automationValueAt(track,"volume",step)/100;
        const pan = Math.max(-1, Math.min(1, (automationValueAt(track,"pan",step)-50)/50));
        const reverb = automationValueAt(track,"reverb",step)/100;
        chain.trackOut.gain.setValueAtTime(audible?vol:0, t);
        chain.panNode.pan.setValueAtTime(pan, t);
        chain.eqLow.gain.setValueAtTime(automationValueAt(track,"eqLow",step)/100*48-24, t);
        chain.eqMid.gain.setValueAtTime(automationValueAt(track,"eqMid",step)/100*48-24, t);
        chain.eqHigh.gain.setValueAtTime(automationValueAt(track,"eqHigh",step)/100*48-24, t);
        chain.dry.gain.setValueAtTime(1-reverb*0.6, t);
        chain.wet.gain.setValueAtTime(reverb, t);
      }
    }
    if(!audible) return;
    for(let pass=0; pass<repeats; pass++){
      const passOffset = pass*loopSec;
      track.notes.forEach(note=>{
        const startTime = passOffset + note.step*stepDurSec();
        playNote(track, note.pitch, startTime, note.dur*stepDurSec()*0.92, note.bendTo,
          clampedBendStartStep(note)*stepDurSec(), clampedBendEndStep(note)*stepDurSec(),
          {ctx: offlineCtx, chain, noiseBuffer: noiseBuf});
      });
    }
  });
  return offlineCtx.startRendering();
}
async function renderProjectToWavBlob(loopCount){
  return audioBufferToWavBlob(await renderProjectToAudioBuffer(loopCount));
}

/* ---- export: MP3 (via bundled lamejs — see lamejs.min.js) ---- */
function audioBufferToMp3Blob(buffer){
  const numCh = Math.min(2, buffer.numberOfChannels);
  const encoder = new lamejs.Mp3Encoder(numCh, buffer.sampleRate, 160);
  const toInt16 = (channelData)=>{
    const out = new Int16Array(channelData.length);
    for(let i=0;i<channelData.length;i++){
      const s = Math.max(-1, Math.min(1, channelData[i]));
      out[i] = s<0 ? s*0x8000 : s*0x7FFF;
    }
    return out;
  };
  const left = toInt16(buffer.getChannelData(0));
  const right = numCh>1 ? toInt16(buffer.getChannelData(1)) : null;
  const blockSize = 1152; // lamejs encodes one MPEG frame's worth of samples per call
  const chunks = [];
  for(let i=0; i<left.length; i+=blockSize){
    const chunk = numCh>1
      ? encoder.encodeBuffer(left.subarray(i,i+blockSize), right.subarray(i,i+blockSize))
      : encoder.encodeBuffer(left.subarray(i,i+blockSize));
    if(chunk.length) chunks.push(chunk);
  }
  const finalChunk = encoder.flush();
  if(finalChunk.length) chunks.push(finalChunk);
  return new Blob(chunks, {type:"audio/mpeg"});
}
async function renderProjectToMp3Blob(loopCount){
  return audioBufferToMp3Blob(await renderProjectToAudioBuffer(loopCount));
}

/* ---- export: Standard MIDI File (format 1) ---- */
function midiVarLen(value){
  const bytes = [value & 0x7F];
  value = Math.floor(value/128);
  while(value>0){ bytes.unshift((value & 0x7F) | 0x80); value = Math.floor(value/128); }
  return bytes;
}
function midiTrackChunk(eventBytes){
  const len = eventBytes.length;
  return [0x4D,0x54,0x72,0x6B, (len>>>24)&0xFF,(len>>>16)&0xFF,(len>>>8)&0xFF,len&0xFF, ...eventBytes];
}
// rough General MIDI program per waveform, just so a MIDI player picks *some* reasonable timbre
function gmProgramForWave(wave){
  return {square:80, pulse25:80, pulse12:80, sawtooth:81, triangle:73, sine:89, custom:0}[wave] ?? 0;
}
function projectToMidiBytes(){
  const PPQ = 480, ticksPerStep = PPQ/4; // steps are always 16th notes
  const ntracks = state.tracks.length+1;
  const header = [0x4D,0x54,0x68,0x64, 0,0,0,6, 0,1, (ntracks>>8)&0xFF,ntracks&0xFF, (PPQ>>8)&0xFF, PPQ&0xFF];
  const conductorEvents = [];
  const usPerQuarter = Math.round(60000000/state.bpm);
  conductorEvents.push(...midiVarLen(0), 0xFF,0x51,0x03, (usPerQuarter>>16)&0xFF,(usPerQuarter>>8)&0xFF,usPerQuarter&0xFF);
  const denomPow2 = Math.round(Math.log2(state.timeSig[1]));
  conductorEvents.push(...midiVarLen(0), 0xFF,0x58,0x04, state.timeSig[0], denomPow2, 24, 8);
  conductorEvents.push(...midiVarLen(0), 0xFF,0x2F,0x00);
  const chunks = [midiTrackChunk(conductorEvents)];
  state.tracks.forEach((track,idx)=>{
    const channel = track.instrument.wave==="noise" ? 9 : (idx%15 >= 9 ? idx%15+1 : idx%15); // dodge ch.10 (drums) for melodic tracks
    const events = [];
    const nameBytes = Array.from(track.name).map(c=>c.charCodeAt(0)).slice(0,40);
    events.push(...midiVarLen(0), 0xFF,0x03, nameBytes.length, ...nameBytes);
    events.push(...midiVarLen(0), 0xC0|channel, gmProgramForWave(track.instrument.wave));
    const noteEvents = [];
    track.notes.forEach(n=>{
      const onTick = Math.round(n.step*ticksPerStep);
      const offTick = Math.round((n.step+n.dur)*ticksPerStep);
      const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
      noteEvents.push({tick:onTick, bytes:[0x90|channel, pitch, 100]});
      noteEvents.push({tick:Math.max(onTick+1,offTick), bytes:[0x80|channel, pitch, 0]});
    });
    noteEvents.sort((a,b)=> a.tick-b.tick);
    let prevTick = 0;
    noteEvents.forEach(ev=>{
      events.push(...midiVarLen(ev.tick-prevTick), ...ev.bytes);
      prevTick = ev.tick;
    });
    events.push(...midiVarLen(0), 0xFF,0x2F,0x00);
    chunks.push(midiTrackChunk(events));
  });
  const bytes = [].concat(header, ...chunks);
  return new Uint8Array(bytes);
}

/* ---- import: Standard MIDI File (.mid/.midi) — the inverse of projectToMidiBytes above ---- */
function midiReadVarLen(bytes, pos){
  let value = 0, byte;
  do{ byte = bytes[pos++]; value = (value<<7) | (byte & 0x7F); } while(byte & 0x80);
  return {value, pos};
}
function parseMidiFile(arrayBuffer){
  const bytes = new Uint8Array(arrayBuffer);
  let pos = 0;
  function readStr(len){ let s=""; for(let i=0;i<len;i++) s+=String.fromCharCode(bytes[pos++]); return s; }
  function readU32(){ const v=(bytes[pos]<<24)|(bytes[pos+1]<<16)|(bytes[pos+2]<<8)|bytes[pos+3]; pos+=4; return v>>>0; }
  function readU16(){ const v=(bytes[pos]<<8)|bytes[pos+1]; pos+=2; return v; }
  if(readStr(4)!=="MThd") throw new Error("not a MIDI file");
  const hdrLen = readU32();
  readU16(); // format — not needed, format 0/1 both handled the same by just reading every MTrk chunk
  const ntrks = readU16();
  const division = readU16();
  pos += Math.max(0, hdrLen-6); // header is normally exactly 6 bytes, but skip forward if a file pads it
  if(division & 0x8000) throw new Error("SMPTE-based MIDI timing isn't supported");
  const ticksPerStep = division/4; // steps are always 16th notes — same convention projectToMidiBytes uses

  const tracks = [];
  let tempoUsPerQuarter = 500000; // default 120bpm, overwritten if the file sets a tempo meta event
  let timeSigNum = 4, timeSigDenPow = 2;

  for(let t=0; t<ntrks && pos<bytes.length; t++){
    if(readStr(4)!=="MTrk") break;
    const chunkLen = readU32();
    const chunkEnd = pos+chunkLen;
    let tick = 0, runningStatus = 0, trackName = null;
    const activeNotes = new Map(); // pitch -> tick note-on happened, so a later note-off can compute duration
    const noteEvents = [];
    while(pos<chunkEnd){
      const dt = midiReadVarLen(bytes,pos); pos = dt.pos; tick += dt.value;
      let statusByte = bytes[pos];
      if(statusByte & 0x80){ runningStatus = statusByte; pos++; } else { statusByte = runningStatus; }
      if(statusByte===0xFF){
        const metaType = bytes[pos++];
        const len = midiReadVarLen(bytes,pos); pos = len.pos;
        if(metaType===0x03){ const name = readStr(len.value); if(trackName==null) trackName = name; }
        else if(metaType===0x51 && len.value===3){ tempoUsPerQuarter = (bytes[pos]<<16)|(bytes[pos+1]<<8)|bytes[pos+2]; pos+=len.value; }
        else if(metaType===0x58 && len.value>=2){ timeSigNum = bytes[pos]; timeSigDenPow = bytes[pos+1]; pos+=len.value; }
        else pos += len.value;
      } else if(statusByte===0xF0 || statusByte===0xF7){
        const len = midiReadVarLen(bytes,pos); pos = len.pos; pos += len.value;
      } else {
        const type = statusByte & 0xF0;
        if(type===0x90 || type===0x80){
          const pitch = bytes[pos++], vel = bytes[pos++];
          if(type===0x90 && vel>0){
            activeNotes.set(pitch, tick);
          } else {
            const startTick = activeNotes.get(pitch);
            if(startTick!=null){ activeNotes.delete(pitch); noteEvents.push({startTick, endTick:tick, pitch}); }
          }
        } else if(type===0xC0 || type===0xD0){ pos += 1; }
        else { pos += 2; }
      }
    }
    pos = chunkEnd;
    if(noteEvents.length) tracks.push({name: trackName || ("Track "+(t+1)), noteEvents});
  }
  const bpm = Math.round(60000000/tempoUsPerQuarter);
  return {ticksPerStep, tracks, bpm, timeSig:[timeSigNum, Math.pow(2,timeSigDenPow)]};
}
// imports parsed MIDI tracks by appending them to the current project (like addTrack/paste-track),
// so it composes with undo history rather than replacing the project the way loadProject does
function importMidiTracks(parsed){
  if(!parsed.tracks.length){ toast("No note data found in that MIDI file"); return; }
  pushHistory();
  const startColorIdx = state.tracks.length;
  let imported = 0;
  parsed.tracks.forEach((mt, i)=>{
    const t = makeTrack(mt.name, startColorIdx+i);
    buildChain(t);
    mt.noteEvents.forEach(ne=>{
      const stepStart = Math.round(ne.startTick/parsed.ticksPerStep);
      const stepEnd = ne.endTick/parsed.ticksPerStep;
      const dur = Math.max(1, Math.round(stepEnd-stepStart));
      // clamp into the app's representable pitch range (matches rowToMidi/TOP_MIDI/TOTAL_ROWS)
      const pitch = Math.max(TOP_MIDI-TOTAL_ROWS+1, Math.min(TOP_MIDI, ne.pitch));
      const note = {id: nextNoteId++, step:stepStart, pitch, dur, bendTo:null};
      t.notes.push(note);
      extendRegionsForNote(t, note);
    });
    if(t.notes.length){ state.tracks.push(t); imported++; }
  });
  if(!imported){ undoStack.pop(); toast("No note data found in that MIDI file"); return; }
  if(parsed.bpm>=30 && parsed.bpm<=300){
    state.bpm = parsed.bpm;
    document.getElementById("bpmInput").value = state.bpm;
  }
  state.selectedTrackId = state.tracks[state.tracks.length-1].id;
  renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); buildTrackList(); recomputeStepsTotal();
  toast("Imported "+imported+" track"+(imported===1?"":"s")+" from MIDI");
}

/* ---- Save modal: title + filetype, native "save as" picker when available ---- */
const exportTypeInfo = {
  mp3: {ext:"mp3", mime:"audio/mpeg", desc:"Audio"},
  wav: {ext:"wav", mime:"audio/wav", desc:"Audio"},
  mid: {ext:"mid", mime:"audio/midi", desc:"MIDI"},
  json:{ext:"json", mime:"application/json", desc:"Project"}
};
async function saveBlobToDisk(blob, suggestedName, mime){
  if(window.showSaveFilePicker){
    try{
      const ext = suggestedName.slice(suggestedName.lastIndexOf("."));
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types:[{description:mime, accept:{[mime]:[ext]}}]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    }catch(err){
      if(err && err.name==="AbortError") return false; // user cancelled the picker — don't also fall back
      // fall through to the download fallback for any other failure (e.g. API unsupported despite the feature check)
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = suggestedName; a.click();
  return true;
}
/* ---- small modal used to tell the user something before continuing (resolves when acknowledged) ---- */
function showInfoDialog(title, body){
  return new Promise(resolve=>{
    const modal = document.getElementById("infoModal");
    document.getElementById("infoTitle").textContent = title;
    document.getElementById("infoBody").textContent = body;
    modal.classList.remove("hidden");
    const ok = document.getElementById("infoOkBtn");
    const done = ()=>{ ok.removeEventListener("click", done); modal.classList.add("hidden"); resolve(); };
    ok.addEventListener("click", done);
    ok.focus();
  });
}
// the loop count only means anything while looping is switched on
function syncExportLoopUI(){
  const on = document.getElementById("exportLoopChk").checked;
  document.getElementById("exportLoopCount").disabled = !on;
}
document.getElementById("exportLoopChk").addEventListener("change", syncExportLoopUI);
document.getElementById("saveBtn").addEventListener("click", ()=>{
  // prefilled from the sub-header's project title, but still freely editable here
  document.getElementById("exportTitleInput").value = state.projectTitle || "Bit Beats Project";
  document.getElementById("exportStatus").textContent = "";
  syncExportLoopUI();
  document.getElementById("exportModal").classList.remove("hidden");
  document.getElementById("exportTitleInput").focus();
});
document.getElementById("exportCancelBtn").addEventListener("click", ()=>{
  document.getElementById("exportModal").classList.add("hidden");
});
document.getElementById("exportConfirmBtn").addEventListener("click", async ()=>{
  const titleInput = document.getElementById("exportTitleInput");
  const title = titleInput.value.trim() || "Bit Beats Project";
  state.projectTitle = title;
  renderProjectTitle();
  const type = document.getElementById("exportTypeSel").value;
  const info = exportTypeInfo[type];
  const statusEl = document.getElementById("exportStatus");
  const confirmBtn = document.getElementById("exportConfirmBtn");
  const loopOn = document.getElementById("exportLoopChk").checked;
  const loopCount = loopOn
    ? Math.max(2, Math.min(64, Math.round(Number(document.getElementById("exportLoopCount").value)||2)))
    : 1;
  // MIDI and JSON describe the project itself, not a rendered performance, so there is nothing to
  // repeat in the file — say so, then continue with a normal single-pass export once acknowledged
  if(loopOn && (type==="mid" || type==="json")){
    await showInfoDialog("Looping doesn't apply to ."+info.ext+" files",
      "Repeats only affect rendered audio (MP3 / WAV). A ."+info.ext+" file stores the project itself, "+
      "so it will be saved once through — you can still repeat it in whatever plays or opens it. "+
      "Saving a single pass now.");
  }
  confirmBtn.disabled = true;
  try{
    let blob;
    if(type==="json"){
      blob = new Blob([JSON.stringify(serializeProject(), null, 1)], {type:info.mime});
    } else if(type==="mid"){
      statusEl.textContent = "Writing MIDI…";
      blob = new Blob([projectToMidiBytes()], {type:info.mime});
    } else if(type==="mp3"){
      statusEl.textContent = loopCount>1 ? "Rendering audio ("+loopCount+" repeats)…" : "Rendering audio…";
      blob = await renderProjectToMp3Blob(loopCount);
    } else {
      statusEl.textContent = loopCount>1 ? "Rendering audio ("+loopCount+" repeats)…" : "Rendering audio…";
      blob = await renderProjectToWavBlob(loopCount);
    }
    await saveBlobToDisk(blob, title+"."+info.ext, info.mime);
    document.getElementById("exportModal").classList.add("hidden");
    toast(info.desc+" saved");
  }catch(err){
    statusEl.textContent = "Save failed: "+(err && err.message ? err.message : "unknown error");
  }finally{
    confirmBtn.disabled = false;
  }
});
document.getElementById("loadBtn").addEventListener("click", ()=> document.getElementById("loadInput").click());
document.getElementById("loadInput").addEventListener("change",(e)=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  if(/\.midi?$/i.test(file.name)){
    reader.onload = ()=>{
      try{ importMidiTracks(parseMidiFile(reader.result)); }
      catch(err){ toast("Could not read MIDI file: "+(err && err.message ? err.message : "unknown error")); }
    };
    reader.readAsArrayBuffer(file);
  } else {
    reader.onload = ()=>{
      try{
        const data = JSON.parse(reader.result);
        loadProject(data);
        toast("Project loaded");
      }catch(err){ toast("Invalid project file"); }
    };
    reader.readAsText(file);
  }
  e.target.value="";
});
function loadProject(data){
  STEPS_TOTAL = STEPS_TOTAL_BASE;
  state.projectTitle = data.projectTitle || "Bit Beats Project";
  state.bpm=data.bpm||120; state.timeSig=data.timeSig||[4,4]; state.key=data.key||"C"; state.mode=data.mode||"Major";
  state.octaveFocus=data.octaveFocus||4; state.noteLenSteps=data.noteLenSteps||4;
  document.getElementById("bpmInput").value=state.bpm;
  document.getElementById("timeSigSel").value=state.timeSig.join("/");
  document.getElementById("keySel").value=state.key; document.getElementById("modeSel").value=state.mode;
  document.getElementById("octaveSel").value=state.octaveFocus;
  document.getElementById("noteLenSel").value=state.noteLenSteps;
  // assigning .value never fires "change", so the chord palette's key/mode labels would still be
  // showing the OUTGOING project's scale degrees until the user touched one of those two selects.
  // That same silence is what a load DEPENDS on where #modeSel is concerned: the change handler
  // transposes every note by scale degree, and a project whose notes were saved in its own mode must
  // come back exactly as written rather than being re-transposed out of it on the way in.
  renderChordPalette();
  renderProjectTitle();
  nextTrackId=1; nextNoteId=1;
  state.tracks = (data.tracks||[]).map(t=>{
    const track = makeTrack(t.name, 0);
    track.id = t.id||nextTrackId; nextTrackId=Math.max(nextTrackId, track.id+1);
    track.color = t.color||track.color; track.muted=!!t.muted; track.solo=!!t.solo; track.volume = t.volume??0.8;
    track.pan = t.pan??50;
    track.instrument = Object.assign(defaultInstrument(), t.instrument||{});
    // the save file carries a sampleId but no audio — if this session's registry still holds that entry
    // (a save/reload round trip without reloading the page) the buffer comes straight back
    resolveTrackSample(track);
    track.notes = (t.notes||[]).map(n=>{ nextNoteId=Math.max(nextNoteId, (n.id||0)+1); return {id:n.id||nextNoteId++, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null, bendStartStep:n.bendStartStep??0, bendEndStep:n.bendEndStep??null}; });
    track.regions = (t.regions||null) && t.regions.map(r=>{ nextNoteId=Math.max(nextNoteId, (r.id||0)+1); return {id:r.id||nextNoteId++, start:r.start, end:r.end}; });
    track.automation = defaultAutomation();
    if(t.automation){
      Object.keys(track.automation).forEach(k=>{
        track.automation[k] = (t.automation[k]||[]).map(p=>{ nextNoteId=Math.max(nextNoteId,(p.id||0)+1); return {id:p.id||nextNoteId++, step:p.step, value:p.value}; });
      });
    }
    buildChain(track);
    return track;
  });
  state.selectedTrackId = state.tracks.length? state.tracks[0].id : null;
  state.advancedTrackId = null; state.advancedParam = "volume";
  selectedNoteIds.clear(); selectedRegionIds.clear(); selectedAutoPointIds.clear(); phantomSelection = null;
  undoStack=[]; redoStack=[];
  state.loop = {enabled:false, start:0, end:stepsPerBar()};
  sizeGrid(); buildPianoLabels(); drawGridLines();
  // state.samples is deliberately NOT reset here: the decoded buffers this session holds are the only
  // thing a loaded project's sampleIds can possibly resolve against, since no audio is written to file
  renderSamplePanel();
  renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); buildTrackList(); renderAdvancedEditor();
  recomputeStepsTotal();
  document.getElementById("loopBtn").classList.remove("on");
}
document.getElementById("newBtn").addEventListener("click", ()=>{
  if(!confirm("Start a new project? Unsaved changes will be lost.")) return;
  stopPlayback(true);
  STEPS_TOTAL = STEPS_TOTAL_BASE;
  state.tracks=[]; state.selectedTrackId=null; selectedNoteIds.clear(); selectedRegionIds.clear();
  state.advancedTrackId=null; selectedAutoPointIds.clear(); phantomSelection = null;
  // the sample registry is project data too, so a genuinely new project starts with none — which also
  // takes #sampleMenuBtn back out of .instTopRow (see updateSampleMenuBtn, via renderSamplePanel)
  state.samples=[]; nextSampleId=1; sampleMenuOpen=false; stopSamplePreview();
  undoStack=[]; redoStack=[];
  initDefaultProject();
});

/* ======================================================================
   DOCKABLE SIDE PANELS

   A "dock panel" is a menu with two homes. While the advanced track editor is CLOSED it floats as a
   dropdown under its own trigger button (the #colorPicker treatment). While the editor is OPEN the very
   same element is re-parented into one of the editor's dock slots, so the two menus sit side by side in
   one card instead of one covering the other. Toggling the editor has to move it live, in both
   directions, which is why this is a registry rather than three lines inside the chord panel's own code:
   the custom-sample-list panel is going to want exactly this behaviour in #advDockRight.

   To add a panel: give it a body-level element, then call registerDockPanel({...}) once. Nothing else —
   renderAdvancedEditor() already calls syncDockedPanels() on every open/close/resize of the editor.
   The element must not assume a parent: it keeps its children across the move, and only the
   .floating / .docked class swaps (style.css owns what each of those two looks like).
   ====================================================================== */
const DOCK_PANELS = []; // {panelId, slotId, anchorId, isOpen()}
function registerDockPanel(cfg){ DOCK_PANELS.push(cfg); return cfg; }

function placeDockPanel(cfg){
  const el = document.getElementById(cfg.panelId);
  const slot = document.getElementById(cfg.slotId);
  if(!el || !slot) return;
  // a closed panel hides its slot too, so an unused dock contributes neither width nor a divider line
  if(!cfg.isOpen()){ el.classList.add("hidden"); slot.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  // read off the editor's own .hidden class rather than state.advancedTrackId: renderAdvancedEditor()
  // sets that class first and calls us second, so this is always the state the user can actually see
  const advOpen = !document.getElementById("advancedEditor").classList.contains("hidden");
  if(advOpen){
    if(el.parentNode!==slot) slot.appendChild(el);
    slot.classList.remove("hidden");
    el.classList.remove("floating"); el.classList.add("docked");
    el.style.left = ""; el.style.top = ""; // the fixed-position coords would survive the class swap otherwise
  } else {
    if(el.parentNode!==document.body) document.body.appendChild(el);
    slot.classList.add("hidden");
    el.classList.remove("docked"); el.classList.add("floating");
    const anchor = document.getElementById(cfg.anchorId);
    if(anchor){
      const rect = anchor.getBoundingClientRect();
      // measured AFTER .floating is applied, since that is the class that gives the panel its width.
      // Anchored by its RIGHT edge because these triggers live at the right end of the sub-header —
      // left-anchoring a 250px card there would hang it off the side of the window.
      const w = el.offsetWidth || 252;
      const left = Math.max(8, Math.min(rect.right-w, window.innerWidth-w-8));
      el.style.left = Math.round(left)+"px";
      el.style.top = Math.round(rect.bottom+6)+"px";
    }
  }
}
function syncDockedPanels(){ DOCK_PANELS.forEach(placeDockPanel); }

/* ======================================================================
   CHORD PALETTE (shell)

   Presentation only. Nothing in here writes to state.tracks, places notes or transposes anything —
   picking a root / quality / scale degree updates this panel's own highlight and stops there. The chord
   NAMES are derived, because a palette that showed the wrong spelling for the current key would be
   useless to look at, but naming is labelling, not playing.
   ====================================================================== */
const CHORD_QUALITIES = [
  {id:"maj",  label:"maj",  suffix:""},     {id:"min",  label:"min",  suffix:"m"},
  {id:"dim",  label:"dim",  suffix:"dim"},  {id:"aug",  label:"aug",  suffix:"aug"},
  {id:"sus2", label:"sus2", suffix:"sus2"}, {id:"sus4", label:"sus4", suffix:"sus4"},
  {id:"6",    label:"6",    suffix:"6"},    {id:"m6",   label:"m6",   suffix:"m6"},
  {id:"7",    label:"7",    suffix:"7"},    {id:"maj7", label:"maj7", suffix:"maj7"},
  {id:"m7",   label:"m7",   suffix:"m7"},   {id:"m7b5", label:"m7♭5", suffix:"m7♭5"},
  {id:"dim7", label:"dim7", suffix:"dim7"}, {id:"9",    label:"9",    suffix:"9"},
  {id:"maj9", label:"maj9", suffix:"maj9"}, {id:"m9",   label:"m9",   suffix:"m9"},
  {id:"add9", label:"add9", suffix:"add9"}, {id:"11",   label:"11",   suffix:"11"},
  {id:"13",   label:"13",   suffix:"13"}
];
// same substitution buildPianoLabels() makes: "#" is an ASCII stand-in stored in NOTE_NAMES, "♯" is
// what a musician reads, and the palette is pure display so it always shows the real glyph
function noteLabel(n){ return n.replace("#","♯"); }
function qualitySuffix(id){ const q = CHORD_QUALITIES.find(x=>x.id===id); return q ? q.suffix : ""; }

// Works out what each scale degree's triad is CALLED in the current key/mode by stacking scale thirds
// and reading the resulting interval pattern — a major third + perfect fifth is a major triad and gets
// an upper-case numeral, a minor third + diminished fifth is "vii°", and so on. No pitches leave this
// function; it only ever returns strings for the palette to print.
function diatonicChords(){
  const keyIdx = Math.max(0, NOTE_NAMES.indexOf(state.key));
  const raw = SCALES[state.mode] || SCALES.Major;
  // Chromatic has all twelve notes and therefore no scale degrees to stack thirds on, so the palette
  // falls back to the parallel major — the same seven chords a player would reach for over it anyway
  const sc = raw.length===7 ? raw : SCALES.Major;
  const ROMAN = ["I","II","III","IV","V","VI","VII"];
  return sc.map((_,i)=>{
    // degree i+k, carrying the +12 for every time the stack wraps past the top of the scale
    const at = k=> sc[(i+k)%7] + 12*Math.floor((i+k)/7);
    const third = at(2)-at(0), fifth = at(4)-at(0);
    let quality = "maj", mark = "", roman = ROMAN[i];
    if(third===3 && fifth===6){ quality="dim"; mark="°"; roman=roman.toLowerCase(); }
    else if(third===3){ quality="min"; roman=roman.toLowerCase(); }
    else if(fifth===8){ quality="aug"; mark="+"; }
    const root = NOTE_NAMES[(keyIdx+sc[i])%12];
    return {root, quality, degree:roman+mark, name:noteLabel(root)+qualitySuffix(quality)};
  });
}

let chordMenuOpen = false;
// purely local to this panel — read by nothing outside it, and deliberately not part of `state` (it is
// UI position, not project data, so it stays out of save files and out of undo/redo)
let chordSel = {root:null, quality:"maj", degree:null};
// until the user picks a root by hand the root row tracks the Key select, so the palette opens already
// pointing at the key you are working in; once they choose one it stops moving under them
let chordRootTouched = false;

function buildChordPalette(){
  const rootGrid = document.getElementById("chordRootGrid");
  NOTE_NAMES.forEach(n=>{
    const b = document.createElement("button");
    b.className = "chordBtn"; b.dataset.root = n; b.textContent = noteLabel(n);
    rootGrid.appendChild(b);
  });
  const qGrid = document.getElementById("chordQualityGrid");
  CHORD_QUALITIES.forEach(q=>{
    const b = document.createElement("button");
    b.className = "chordBtn"; b.dataset.quality = q.id; b.textContent = q.label;
    qGrid.appendChild(b);
  });
}

function renderChordPalette(){
  if(!chordRootTouched) chordSel.root = state.key;
  document.getElementById("chordKeyLabel").textContent = noteLabel(state.key)+" "+state.mode;

  document.querySelectorAll("#chordRootGrid .chordBtn").forEach(b=>{
    b.classList.toggle("active", b.dataset.root===chordSel.root);
  });
  // the title is the only place the two axes are shown combined, which is what makes a bare "m7" button
  // legible as "the chord you would get is Gm7" without the panel having to spell it out in the grid
  document.querySelectorAll("#chordQualityGrid .chordBtn").forEach(b=>{
    b.classList.toggle("active", b.dataset.quality===chordSel.quality);
    b.title = noteLabel(chordSel.root||state.key)+qualitySuffix(b.dataset.quality);
  });

  const grid = document.getElementById("chordDiatonicGrid");
  const chords = diatonicChords();
  grid.title = (SCALES[state.mode]||[]).length===7
    ? ("Diatonic chords of "+noteLabel(state.key)+" "+state.mode)
    : ("Chromatic has no scale degrees — showing "+noteLabel(state.key)+" Major");
  grid.innerHTML = "";
  chords.forEach((c,i)=>{
    const b = document.createElement("button");
    b.className = "chordBtn chordDegBtn"+(chordSel.degree===i?" active":"");
    b.dataset.degree = i;
    b.title = c.name;
    const deg = document.createElement("span"); deg.className="deg"; deg.textContent = c.degree;
    const nm = document.createElement("span"); nm.className="nm"; nm.textContent = c.name;
    b.appendChild(deg); b.appendChild(nm);
    grid.appendChild(b);
  });
}

function closeChordMenu(){
  chordMenuOpen = false;
  document.getElementById("chordMenuBtn").classList.remove("on");
  syncDockedPanels();
}

document.getElementById("chordMenuBtn").addEventListener("click",()=>{
  chordMenuOpen = !chordMenuOpen;
  document.getElementById("chordMenuBtn").classList.toggle("on", chordMenuOpen);
  if(chordMenuOpen) renderChordPalette();
  syncDockedPanels();
});
// Selection is visual and local, exactly as specified: no note is written, nothing is transposed, and
// state.tracks is never touched. Picking a root or a quality drops the scale-degree highlight because
// the degree tile stands for a specific root+quality pair that no longer holds; picking a degree lights
// its own root and quality back up, so the three rows always agree with each other.
document.getElementById("chordRootGrid").addEventListener("click",(e)=>{
  const b = e.target.closest(".chordBtn"); if(!b) return;
  chordSel.root = b.dataset.root; chordSel.degree = null; chordRootTouched = true;
  renderChordPalette();
});
document.getElementById("chordQualityGrid").addEventListener("click",(e)=>{
  const b = e.target.closest(".chordBtn"); if(!b) return;
  chordSel.quality = b.dataset.quality; chordSel.degree = null;
  renderChordPalette();
});
document.getElementById("chordDiatonicGrid").addEventListener("click",(e)=>{
  const b = e.target.closest(".chordBtn"); if(!b) return;
  const c = diatonicChords()[Number(b.dataset.degree)]; if(!c) return;
  chordSel.degree = Number(b.dataset.degree);
  chordSel.root = c.root; chordSel.quality = c.quality; chordRootTouched = true;
  renderChordPalette();
});
// outside-click dismissal is the FLOATING presentation's rule only (mirroring closeColorPicker's
// handler). Docked, the panel is a column of the advanced editor like #advTabs is — clicking a note in
// the roll must no more close it than it closes the automation lane beside it.
document.addEventListener("mousedown",(e)=>{
  if(!chordMenuOpen) return;
  const el = document.getElementById("chordPanel");
  if(!el.classList.contains("floating")) return;
  if(e.target.closest("#chordPanel") || e.target.closest("#chordMenuBtn")) return;
  closeChordMenu();
});
// added as a SEPARATE listener rather than folded into the #keySel / #modeSel handlers above, so the
// palette's label refresh cannot collide with whatever else those two selects grow to do. Registered
// after them, so state.key / state.mode are already updated by the time this runs.
["keySel","modeSel"].forEach(id=>{
  document.getElementById(id).addEventListener("change", ()=>{ renderChordPalette(); });
});

buildChordPalette();
renderChordPalette();
registerDockPanel({panelId:"chordPanel", slotId:"advDockLeft", anchorId:"chordMenuBtn", isOpen:()=>chordMenuOpen});

/* ======================================================================
   CUSTOM SAMPLE MANAGER

   The registry's second face: a list of the project's uploads where a row is exactly a gray play button
   and the sample's title. The title renames in place using the same idiom as instrument names and the
   project title (plain text, swapped for a bordered <input> on double-click, committed on Enter/blur) —
   and because the waveform dropdowns label their options from state.samples, a rename lands in both of
   them at once.

   Its trigger lives beside #uploadSampleBtn and only exists once there is something to manage. The panel
   is a dock panel (see registerDockPanel above): a dropdown under that button while the advanced editor
   is closed, and docked into #advDockRight — right of the automation lane, behind the light-gray
   divider — while it is open.
   ====================================================================== */
let sampleMenuOpen = false;
// exactly one preview voice at a time: clicking play again (or on another row) replaces the one that is
// sounding instead of layering another copy on top of it
let samplePreviewSrc = null;
function stopSamplePreview(){
  if(!samplePreviewSrc) return;
  // stop() on a source that already ran to the end throws in some engines, and the only thing that
  // matters here is that a still-sounding one goes quiet — so a failure is genuinely nothing to do
  try{ samplePreviewSrc.onended = null; samplePreviewSrc.stop(); }catch(_){}
  samplePreviewSrc = null;
}
function previewSample(id){
  const s = findSample(id);
  // a registry entry with no buffer is reachable: a project loaded from JSON knows a sampleId but the
  // save file never carried the audio, so there is nothing decoded to play
  if(!s || !s.buffer){ toast("That sample has no audio loaded"); return; }
  if(actx.state==="suspended") actx.resume();
  stopSamplePreview();
  const src = actx.createBufferSource(); src.buffer = s.buffer;
  const g = actx.createGain(); g.gain.value = 0.9;
  // straight to the destination, deliberately NOT through a track's chain: this auditions the FILE, so
  // it must not arrive coloured by whichever track's EQ, reverb and volume happen to point at it
  src.connect(g); g.connect(actx.destination);
  src.onended = ()=>{ if(samplePreviewSrc===src) samplePreviewSrc = null; };
  src.start();
  samplePreviewSrc = src;
}

// the trigger exists only while the registry has something in it, and an empty registry also forces the
// panel shut, so it can never be left hanging open over a list with no rows
function updateSampleMenuBtn(){
  const btn = document.getElementById("sampleMenuBtn");
  if(!btn) return;
  const has = state.samples.length>0;
  if(!has && sampleMenuOpen){ sampleMenuOpen = false; stopSamplePreview(); }
  btn.classList.toggle("hidden", !has);
  btn.classList.toggle("on", sampleMenuOpen);
  fitInstTopRow(); // the row just gained or lost a button, so its label budget changed
}
function closeSampleMenu(){
  sampleMenuOpen = false;
  document.getElementById("sampleMenuBtn").classList.remove("on");
  stopSamplePreview();
  syncDockedPanels();
}

function renderSamplePanel(){
  const list = document.getElementById("sampleList");
  if(!list) return;
  const n = state.samples.length;
  document.getElementById("sampleCountLabel").textContent = n ? (n+(n===1?" file":" files")) : "";
  list.innerHTML = "";
  state.samples.forEach(s=>{
    const row = document.createElement("div");
    row.className = "sampleRow"; row.dataset.id = s.id;
    row.innerHTML = `
      <button class="samplePlayBtn" data-role="samplePlay" title="Preview this sample">&#9654;</button>
      <span class="sampleNameText" data-role="sampleNameText" title="Double-click to rename">${escapeHtml(s.name)}</span>`;
    list.appendChild(row);
  });
  updateSampleMenuBtn();
  syncDockedPanels();
}

/* ---------- rename a sample: double-click, exactly like an instrument name ----------
   A plain "dblclick" listener is enough here (unlike the instrument list, which has to detect its own
   double-click from e.detail): clicking a sample row selects nothing and rebuilds nothing, so the span
   the first click landed on is still the same node when the second one arrives. */
function beginSampleNameEdit(span){
  const row = span.closest(".sampleRow"); if(!row) return;
  const s = findSample(Number(row.dataset.id)); if(!s) return;
  const input = document.createElement("input");
  input.type = "text"; input.dataset.role = "sampleName"; input.value = s.name;
  const commit = ()=>{
    if(!input.isConnected) return; // re-entry guard: renderSamplePanel below removes the input, which blurs it
    const name = input.value.trim();
    if(name && name!==s.name){
      s.name = name;
      // the dropdowns are the whole point of renaming, so push the new label into both of them now,
      // each re-fitted to its own select's width, rather than waiting for some unrelated rerender
      renderInstrumentList();
      refreshInstrumentEditor();
    }
    renderSamplePanel();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown",(e)=>{
    if(e.key==="Enter"){ commit(); e.preventDefault(); }
    else if(e.key==="Escape"){ input.value = s.name; commit(); e.preventDefault(); }
    // the app-wide shortcuts (Delete, arrows, Ctrl+Z) must not act on keys typed into a name field
    e.stopPropagation();
  });
  span.replaceWith(input);
  input.focus(); input.select();
}

document.getElementById("sampleMenuBtn").addEventListener("click",()=>{
  if(!state.samples.length) return;
  sampleMenuOpen = !sampleMenuOpen;
  document.getElementById("sampleMenuBtn").classList.toggle("on", sampleMenuOpen);
  if(sampleMenuOpen) renderSamplePanel(); else stopSamplePreview();
  syncDockedPanels();
});
document.getElementById("samplePanel").addEventListener("click",(e)=>{
  const btn = e.target.closest("[data-role=samplePlay]"); if(!btn) return;
  const row = btn.closest(".sampleRow"); if(!row) return;
  previewSample(Number(row.dataset.id));
});
document.getElementById("samplePanel").addEventListener("dblclick",(e)=>{
  const span = e.target.closest("[data-role=sampleNameText]"); if(!span) return;
  beginSampleNameEdit(span);
  e.preventDefault(); e.stopPropagation();
});
// outside-click dismissal belongs to the FLOATING presentation only, exactly as it does for the chord
// palette: docked, this panel is a column of the advanced editor and clicking the piano roll must no
// more close it than it closes the automation lane beside it
document.addEventListener("mousedown",(e)=>{
  if(!sampleMenuOpen) return;
  const el = document.getElementById("samplePanel");
  if(!el.classList.contains("floating")) return;
  if(e.target.closest("#samplePanel") || e.target.closest("#sampleMenuBtn")) return;
  closeSampleMenu();
});
registerDockPanel({panelId:"samplePanel", slotId:"advDockRight", anchorId:"sampleMenuBtn",
  isOpen:()=> sampleMenuOpen && state.samples.length>0});

/* ======================================================================
   RESIZABLE PANELS (self-contained local drag handling — these panels are pure
   layout/UI state, not part of state.tracks, so intentionally kept out of
   pushHistory()/snapshotTracks() undo-redo and out of the shared drag-state
   machines used for note/track/automation editing)
   ====================================================================== */
function makeResizer(handleEl, targetEl, opts){
  if(!handleEl || !targetEl) return;
  const axis = opts.axis; // 'x' or 'y'
  let dragging = false, startPos = 0, startSize = 0;
  handleEl.addEventListener("mousedown",(e)=>{
    dragging = true;
    startPos = axis==="x" ? e.clientX : e.clientY;
    const rect = targetEl.getBoundingClientRect();
    startSize = axis==="x" ? rect.width : rect.height;
    e.preventDefault();
  });
  window.addEventListener("mousemove",(e)=>{
    if(!dragging) return;
    const pos = axis==="x" ? e.clientX : e.clientY;
    let delta = pos-startPos;
    if(opts.invert) delta = -delta;
    const newSize = Math.max(opts.min, Math.min(opts.max, startSize+delta));
    targetEl.style[axis==="x"?"width":"height"] = newSize+"px";
    if(opts.onResize) opts.onResize();
  });
  window.addEventListener("mouseup",()=>{
    if(dragging && opts.onResize) opts.onResize();
    dragging = false;
  });
}
makeResizer(document.getElementById("rollDivider"), document.getElementById("advancedEditor"),
  {axis:"y", min:60, max:400, onResize: renderAdvancedEditor});
makeResizer(document.getElementById("arrangeDivider"), document.getElementById("arrange"),
  {axis:"y", min:100, max:520});
// re-measure (never rebuild) the existing rows when the instrument-list column is widened/narrowed:
// both the name width and the control fitting key off the row's own measured width
function refreshInstrumentRowFit(){
  document.querySelectorAll("#instrumentList .instrumentRow").forEach(row=>{
    sizeNameInput(row.querySelector('input[data-role=name]'));
    fitRowControls(row);
  });
}
makeResizer(document.getElementById("vResizerInstrumentList"), document.getElementById("instrumentListCol"),
  {axis:"x", min:150, max:520, onResize: refreshInstrumentRowFit});
// the two labels in .instTopRow are sized from a measurement, so they have to be re-fitted on every
// drag frame — nothing else in the instrument editor keys off the panel's width
makeResizer(document.getElementById("vResizerInstEditor"), document.getElementById("instEditor"),
  {axis:"x", min:220, max:700, invert:true, onResize: fitInstTopRow});

/* ======================================================================
   TOAST
   ====================================================================== */
let toastTimer=null;
function toast(msg){
  const el = document.getElementById("toast"); el.textContent=msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),1600);
}

/* ======================================================================
   INIT
   ====================================================================== */
function initDefaultProject(){
  sizeGrid(); buildPianoLabels(); renderProjectTitle();
  const t1 = makeTrack("Lead Square",0); buildChain(t1); state.tracks.push(t1);
  const t2 = makeTrack("Bass Triangle",1); t2.instrument.wave="triangle"; buildChain(t2); state.tracks.push(t2);
  state.selectedTrackId = t1.id;
  renderSamplePanel(); // empty registry on a fresh project: hides #sampleMenuBtn and its panel
  renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); buildTrackList(); renderAdvancedEditor();
  const midi=(state.octaveFocus+1)*12;
  gridScroll.scrollTop = midiToRow(midi)*ROW_H+GRID_RULER_H - gridScroll.clientHeight/2;
  syncPianoScroll();
  renderPlayheads();
}
// both of these are pure measurement passes over widths that only the viewport decides, so they are
// the two things that must be redone whenever the window changes size
// syncDockedPanels joins them because a FLOATING dock panel is pinned to its trigger's viewport rect,
// which the window moving out from under it invalidates (a docked one re-measures for free via flex)
window.addEventListener("resize", ()=>{ syncSubHeaderLayout(); fitInstTopRow(); syncDockedPanels(); });
initDefaultProject();
fitInstTopRow(); // initDefaultProject()'s renderProjectTitle() already covers syncSubHeaderLayout()

})();

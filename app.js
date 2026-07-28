(function(){
"use strict";

/* ======================================================================
   CONSTANTS / MUSIC THEORY
   ====================================================================== */
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const OCT_MIN = 0, OCT_MAX = 7;
const ROW_H = 18;
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
  bpm:120, timeSig:[4,4], key:"C", mode:"Major", octaveFocus:4, noteLenSteps:4,
  tracks: [], selectedTrackId:null, clipboard:[], trackClipboard:null, playing:false, playStartStep:0,
  loop:{enabled:false, start:0, end:16}
};
let selectedNoteIds = new Set();
let selectedRegionIds = new Set(); // shift-selected split-region blocks in the arrange timeline
let nextTrackId=1, nextNoteId=1;
let editContext = "notes"; // "notes" or "track" — decides what Ctrl+C/Ctrl+V act on

function defaultInstrument(){
  return { wave:"square", volume:0.8, attack:5, release:80, eqLow:0, eqMid:0, eqHigh:0, reverb:0,
           customSampleData:null, customBaseMidi:60 };
}
function makeTrack(name, colorIdx){
  return { id: nextTrackId++, name: name||("Track "+nextTrackId), color: TRACK_COLORS[colorIdx % TRACK_COLORS.length],
           instrument: defaultInstrument(), notes: [], muted:false, solo:false, volume:0.8, regions:null };
}

/* ======================================================================
   UNDO / REDO
   ====================================================================== */
let undoStack = [], redoStack = [];
let historyArmed = false;
function snapshotTracks(){
  return {
    selectedTrackId: state.selectedTrackId,
    tracks: state.tracks.map(t=>({
      id:t.id, name:t.name, color:t.color, muted:t.muted, solo:t.solo, volume:t.volume,
      instrument: Object.assign({}, t.instrument),
      notes: t.notes.map(n=>({...n})),
      regions: t.regions ? t.regions.map(r=>({...r})) : null
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
  state.tracks = snap.tracks.map(t=>{
    const track = { id:t.id, name:t.name, color:t.color, muted:t.muted, solo:t.solo, volume:t.volume,
      instrument: Object.assign({}, t.instrument), notes: t.notes.map(n=>({...n})),
      regions: t.regions ? t.regions.map(r=>({...r})) : null };
    nextTrackId = Math.max(nextTrackId, track.id+1);
    track.notes.forEach(n=>{ nextNoteId = Math.max(nextNoteId, n.id+1); });
    buildChain(track);
    return track;
  });
  selectedNoteIds.clear(); selectedRegionIds.clear();
  renderTrackList(); refreshInstrumentEditor(); renderNotes(); buildOverview();
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

// build (or rebuild) a track's persistent audio chain: input -> eq -> reverb send/dry -> master
function buildChain(track){
  const eqLow = actx.createBiquadFilter(); eqLow.type="lowshelf"; eqLow.frequency.value=320;
  const eqMid = actx.createBiquadFilter(); eqMid.type="peaking"; eqMid.frequency.value=1200; eqMid.Q.value=0.9;
  const eqHigh = actx.createBiquadFilter(); eqHigh.type="highshelf"; eqHigh.frequency.value=3200;
  const input = actx.createGain();
  const dry = actx.createGain(), wet = actx.createGain();
  const conv = actx.createConvolver(); conv.buffer = reverbBuffer;
  const trackOut = actx.createGain();
  input.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
  eqHigh.connect(dry); dry.connect(trackOut);
  eqHigh.connect(conv); conv.connect(wet); wet.connect(trackOut);
  trackOut.connect(masterGain);
  track._chain = {input,eqLow,eqMid,eqHigh,dry,wet,trackOut};
  applyInstrumentToChain(track);
}
function applyInstrumentToChain(track){
  const c = track._chain; if(!c) return;
  const inst = track.instrument;
  c.eqLow.gain.value = inst.eqLow; c.eqMid.gain.value = inst.eqMid; c.eqHigh.gain.value = inst.eqHigh;
  const wetAmt = inst.reverb/100;
  c.dry.gain.value = 1-wetAmt*0.6; c.wet.gain.value = wetAmt;
  c.trackOut.gain.value = (track.muted?0:1) * track.volume;
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

function playNote(track, midi, startTime, durSec, bendToMidi){
  if(!track._chain) buildChain(track);
  const inst = track.instrument;
  const env = actx.createGain();
  env.connect(track._chain.input);
  const atk = Math.max(0.001, inst.attack/1000), rel = Math.max(0.005, inst.release/1000);
  const peak = 0.5*inst.volume;
  env.gain.setValueAtTime(0,startTime);
  env.gain.linearRampToValueAtTime(peak, startTime+atk);
  const sustainEnd = Math.max(startTime+atk, startTime+durSec);
  env.gain.setValueAtTime(peak, sustainEnd);
  env.gain.linearRampToValueAtTime(0.0001, sustainEnd+rel);
  const stopAt = sustainEnd+rel+0.02;
  const hasBend = bendToMidi!=null && bendToMidi!==midi;

  if(inst.wave==="custom" && inst.customBuffer){
    const src = actx.createBufferSource(); src.buffer = inst.customBuffer;
    src.playbackRate.setValueAtTime(Math.pow(2,(midi-inst.customBaseMidi)/12), startTime);
    if(hasBend) src.playbackRate.linearRampToValueAtTime(Math.pow(2,(bendToMidi-inst.customBaseMidi)/12), sustainEnd);
    src.connect(env); src.start(startTime); src.stop(stopAt);
  } else if(inst.wave==="noise"){
    const src = actx.createBufferSource(); src.buffer = getNoiseBuffer(); src.loop=true;
    const bp = actx.createBiquadFilter(); bp.type="bandpass"; bp.Q.value=1.2;
    bp.frequency.setValueAtTime(midiToFreq(midi)*2, startTime);
    if(hasBend) bp.frequency.linearRampToValueAtTime(midiToFreq(bendToMidi)*2, sustainEnd);
    src.connect(bp); bp.connect(env);
    src.start(startTime); src.stop(stopAt);
  } else if(inst.wave==="pulse25" || inst.wave==="pulse12"){
    // approximate pulse wave via two detuned sawtooths (poor-man's PWM) -> simpler: use square with custom periodic wave
    const osc = actx.createOscillator();
    const real = new Float32Array(16), imag = new Float32Array(16);
    const duty = inst.wave==="pulse25"?0.25:0.125;
    for(let n=1;n<16;n++){ real[n]=0; imag[n]=(2/(n*Math.PI))*Math.sin(n*Math.PI*duty); }
    const wave = actx.createPeriodicWave(real,imag,{disableNormalization:false});
    osc.setPeriodicWave(wave);
    osc.frequency.setValueAtTime(midiToFreq(midi), startTime);
    if(hasBend) osc.frequency.linearRampToValueAtTime(midiToFreq(bendToMidi), sustainEnd);
    osc.connect(env); osc.start(startTime); osc.stop(stopAt);
  } else {
    const osc = actx.createOscillator();
    osc.type = inst.wave;
    osc.frequency.setValueAtTime(midiToFreq(midi), startTime);
    if(hasBend) osc.frequency.linearRampToValueAtTime(midiToFreq(bendToMidi), sustainEnd);
    osc.connect(env); osc.start(startTime); osc.stop(stopAt);
  }
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
function startPlayback(){
  if(state.playing) return;
  if(actx.state==="suspended") actx.resume();
  state.playing = true;
  playCtxStartTime = actx.currentTime;
  playStepAt0 = state.playStartStep;
  scheduledUpTo = playStepAt0;
  document.getElementById("playBtn").innerHTML = "&#10074;&#10074;";
  schedulerTimer = setInterval(schedulerTick, 25);
  schedulerTick();
  requestAnimationFrame(animatePlayhead);
}
function stopPlayback(resetHead){
  state.playing = false;
  clearInterval(schedulerTimer);
  document.getElementById("playBtn").innerHTML = "&#9654;";
  if(resetHead) state.playStartStep = 0; else state.playStartStep = currentPlayStep();
  renderPlayheads();
}
function schedulerTick(){
  const lookahead = 0.12; // seconds
  let nowStep = currentPlayStep();
  if(state.loop.enabled && nowStep >= state.loop.end){
    playCtxStartTime = actx.currentTime;
    playStepAt0 = state.loop.start;
    scheduledUpTo = playStepAt0;
    nowStep = playStepAt0;
  }
  const horizon = nowStep + lookahead/stepDurSec();
  state.tracks.forEach(track=>{
    const solo = anySolo();
    const audible = solo ? track.solo : !track.muted;
    if(!audible) return;
    track.notes.forEach(note=>{
      if(note.step >= scheduledUpTo && note.step < horizon){
        const t = playCtxStartTime + (note.step - playStepAt0)*stepDurSec();
        if(t >= actx.currentTime-0.01){
          playNote(track, note.pitch, t, note.dur*stepDurSec()*0.92, note.bendTo);
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
  document.getElementById("playheadOverview").style.left = (step/stepsPerBar()*BAR_PX) +"px";
  positionOverviewFlag();
}

// keeps the little playhead flag pinned to whatever row is currently scrolled to the top of the
// arrange view (like the ruler), instead of staying anchored to the top of the full scrollable content
function positionOverviewFlag(){
  const flag = document.getElementById("playheadOverviewFlag");
  const tc = document.getElementById("timelineCol");
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
    div.style.background = name==="C" ? "var(--row-c)" : (isNatural ? "var(--row-light)" : "var(--row-dark)");
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
  gridInner.style.width=w+"px"; gridInner.style.height=h+"px";
  gridCanvas.width=w; gridCanvas.height=h; gridCanvas.style.width=w+"px"; gridCanvas.style.height=h+"px";
  noteLayer.style.width=w+"px"; noteLayer.style.height=h+"px";
  drawGridLines();
}

// grow the timeline (grid + ruler) to keep some empty room past whatever the furthest note/track content reaches —
// never shrinks back on its own, so the ruler/grid never "run out" as parts extend beyond the original 16 bars
// if a track has been split into regions, make sure a newly-added note always falls inside one —
// growing the nearest region to cover it rather than leaving the note invisible in the overview
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
    buildOverview();
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
    const isNatural = name.indexOf("#")===-1;
    ctx.fillStyle = name==="C" ? "rgba(94,230,168,.18)" : (isNatural ? "#2c2c34" : "#1c1c22");
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

function renderNotes(){
  noteLayer.innerHTML="";
  selectedNoteIds.forEach(id=>{ if(!selectedTrack() || !selectedTrack().notes.some(n=>n.id===id)) selectedNoteIds.delete(id); });
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
    const grip = document.createElement("div");
    grip.className = "bendHandle";
    grip.title = "Drag sideways to resize, up/down to slur/tie into another pitch";
    div.appendChild(grip);
    noteLayer.appendChild(div);

    if(hasBend){
      const destRow = midiToRow(note.bendTo);
      const stubW = STEP_W-2;
      const stubLeft = note.step*STEP_W + note.dur*STEP_W - stubW + 1;
      const stub = document.createElement("div");
      stub.className = "bendStub";
      stub.dataset.id = note.id;
      stub.title = "Drag up/down to change the slur target";
      stub.style.left = stubLeft+"px";
      stub.style.width = stubW+"px";
      stub.style.top = (destRow*ROW_H + 1)+"px";
      stub.style.height = (ROW_H-2)+"px";
      stub.style.background = "var(--accent2)";
      noteLayer.appendChild(stub);

      // the slide is drawn from the note's left edge (rather than the resize handle on the right)
      // so it reads as a glissando sweeping across the tile toward the slur target, independent of
      // whatever's happening at the right-edge resize handle
      const svgNS = "http://www.w3.org/2000/svg";
      const x1 = note.step*STEP_W+1, y1 = row*ROW_H+ROW_H/2;
      const x2 = stubLeft+(stubW-2)/2, y2 = destRow*ROW_H+ROW_H/2;
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
}

/* ======================================================================
   TRACK LIST + ARRANGE OVERVIEW
   ====================================================================== */
const BAR_PX = 60;
function refreshArrangeGridBg(){
  document.querySelectorAll(".timelineRow").forEach(r=> r.style.setProperty("--barpx", BAR_PX+"px"));
}

function renderTrackList(){
  const list = document.getElementById("trackList");
  list.innerHTML="";
  state.tracks.forEach(track=>{
    const row = document.createElement("div");
    row.className="trackRow"+(track.id===state.selectedTrackId?" selected":"");
    row.dataset.id = track.id;
    row.innerHTML = `
      <div class="tname"><span class="swatch" style="background:${track.color}"></span>
        <input type="text" value="${escapeHtml(track.name)}" data-role="name"></div>
      <div class="tctrls">
        <button class="mutebtn ${track.muted?'on':''}" data-role="mute">M</button>
        <button class="solobtn ${track.solo?'on':''}" data-role="solo">S</button>
        <select data-role="wave" style="flex:1; font-size:10px; padding:1px 2px;">
          <option value="square">Square</option><option value="pulse25">Pulse25</option>
          <option value="pulse12">Pulse12</option><option value="triangle">Triangle</option>
          <option value="sawtooth">Saw</option><option value="sine">Sine</option>
          <option value="noise">Noise</option><option value="custom">Custom</option>
        </select>
        <input type="range" data-role="vol" min="0" max="100" value="${Math.round(track.volume*100)}" style="width:40px;">
      </div>`;
    row.querySelector('[data-role=wave]').value = track.instrument.wave;
    list.appendChild(row);
  });
  buildOverview();
}
function escapeHtml(s){ const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }

function buildOverview(){
  const inner = document.getElementById("timelineInner");
  inner.innerHTML = "";
  const loopBar = document.createElement("div"); loopBar.id="loopBar";
  loopBar.innerHTML = '<div id="loopRegion"><div id="loopHandleL" class="loopHandle"></div><div id="loopHandleR" class="loopHandle"></div></div>';
  inner.appendChild(loopBar);
  const ruler = document.createElement("div"); ruler.id="arrangeRuler"; inner.appendChild(ruler);
  const ph = document.createElement("div"); ph.id="playheadOverview"; inner.appendChild(ph);
  const flag = document.createElement("div"); flag.id="playheadOverviewFlag"; inner.appendChild(flag);
  state.tracks.forEach(track=>{
    const row = document.createElement("div");
    row.className="timelineRow"; row.style.setProperty("--barpx",BAR_PX+"px");
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

// renders one overview block spanning [startStep,endStep) in a track's timeline row, with a mini note-pattern preview
function renderTrackBlock(row, track, startStep, endStep, notes, regionId){
  const spb = stepsPerBar();
  const left = startStep/spb*BAR_PX;
  const blockW = Math.max(20, (endStep-startStep)/spb*BAR_PX);
  const block = document.createElement("div");
  block.className = "overviewBlock"+(regionId!=null && selectedRegionIds.has(regionId) ? " regionSelected" : "");
  block.style.left = left+"px";
  block.style.width = blockW+"px";
  block.style.boxSizing = "border-box";
  block.style.background = track.color;
  block.style.color = "#111";
  if(regionId!=null) block.dataset.regionId = regionId;

  const pattern = document.createElement("canvas");
  const blockH = 34, dpr = window.devicePixelRatio||1;
  pattern.width = blockW*dpr; pattern.height = blockH*dpr;
  pattern.style.position="absolute"; pattern.style.left="0"; pattern.style.top="0";
  pattern.style.width=blockW+"px"; pattern.style.height=blockH+"px"; pattern.style.zIndex="0";
  const pctx = pattern.getContext("2d"); pctx.scale(dpr,dpr);
  if(notes.length){
    const totalSteps = Math.max(1, endStep-startStep);
    const pitches = notes.map(n=>n.pitch);
    const minP = Math.min(...pitches), maxP = Math.max(...pitches);
    const range = Math.max(1, maxP-minP);
    pctx.fillStyle = "rgba(0,0,0,.55)";
    notes.forEach(n=>{
      const nx = (n.step-startStep)/totalSteps*blockW;
      const nw = Math.max(1, n.dur/totalSteps*blockW-0.5);
      const t = (n.pitch-minP)/range;
      const ny = (blockH-6) - t*(blockH-12);
      pctx.fillRect(nx, ny, nw, 2);
    });
  }
  block.appendChild(pattern);

  const label = document.createElement("span");
  label.textContent = track.name;
  label.style.position="relative"; label.style.zIndex="1"; label.style.pointerEvents="none";
  block.appendChild(label);

  row.appendChild(block);
}

// bar-number ruler above the arrange timeline, marking measure boundaries
function renderArrangeRuler(totalW){
  const ruler = document.getElementById("arrangeRuler");
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
   INSTRUMENT EDITOR SYNC
   ====================================================================== */
function refreshInstrumentEditor(){
  const track = selectedTrack();
  const editor = document.getElementById("instEditor");
  if(!track){ editor.style.opacity=.4; editor.style.pointerEvents="none"; return; }
  editor.style.opacity=1; editor.style.pointerEvents="auto";
  document.getElementById("instTrackName").textContent = track.name;
  const inst = track.instrument;
  document.getElementById("waveSel").value = inst.wave;
  document.getElementById("volSlider").value = Math.round((track.volume)*100);
  document.getElementById("volVal").textContent = Math.round(track.volume*100);
  document.getElementById("atkSlider").value = inst.attack; document.getElementById("atkVal").textContent = inst.attack+"ms";
  document.getElementById("relSlider").value = inst.release; document.getElementById("relVal").textContent = inst.release+"ms";
  document.getElementById("eqLowSlider").value = inst.eqLow; document.getElementById("eqLowVal").textContent = inst.eqLow+"dB";
  document.getElementById("eqMidSlider").value = inst.eqMid; document.getElementById("eqMidVal").textContent = inst.eqMid+"dB";
  document.getElementById("eqHighSlider").value = inst.eqHigh; document.getElementById("eqHighVal").textContent = inst.eqHigh+"dB";
  document.getElementById("revSlider").value = inst.reverb; document.getElementById("revVal").textContent = inst.reverb+"%";
  document.getElementById("sampleName").textContent = inst.customBuffer ? "sample loaded" : "";
}

/* ======================================================================
   SELECT / ADD TRACK
   ====================================================================== */
function selectTrack(id, opts){
  state.selectedTrackId = id;
  editContext = "track";
  selectedNoteIds.clear();
  renderTrackList(); refreshInstrumentEditor(); renderNotes();
  if(opts && opts.scrollToFirstNote) scrollGridToFirstNote(id);
}
// bring the piano roll to wherever a track's earliest note sits, with that note pinned near the left edge
function scrollGridToFirstNote(trackId){
  const track = state.tracks.find(t=>t.id===trackId);
  if(!track || !track.notes.length) return;
  const firstNote = track.notes.reduce((a,b)=> b.step<a.step ? b : a);
  gridScroll.scrollLeft = Math.max(0, firstNote.step*STEP_W - 40);
  const row = midiToRow(firstNote.pitch);
  gridScroll.scrollTop = Math.max(0, row*ROW_H - gridScroll.clientHeight/2);
  syncPianoScroll();
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
  renderTrackList(); refreshInstrumentEditor(); renderNotes();
}

/* ======================================================================
   NOTE EDITING: click-add, drag-select, drag-move, copy/paste
   ====================================================================== */
let drag = null; // {mode:'select'|'move'|'place', startX,startY, origin notes...}
let playheadDrag = null; // {type:'grid'|'overview'}
let loopDrag = null; // {mode:'move'|'resizeL'|'resizeR', ...}
let trackDrag = null; // {trackId, startX, origin}
let suppressTimelineClick = false;

function xyToStepRow(clientX, clientY){
  const rect = gridInner.getBoundingClientRect();
  const x = clientX-rect.left, y = clientY-rect.top;
  return { step: Math.floor(x/STEP_W), row: Math.floor(y/ROW_H), x, y };
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

noteLayer.addEventListener("mousedown", onGridMouseDown);
gridCanvas.addEventListener("mousedown", onGridMouseDown);

// double-click a tile to delete it
noteLayer.addEventListener("dblclick", (e)=>{
  const track = selectedTrack(); if(!track) return;
  const {step,row} = xyToStepRow(e.clientX,e.clientY);
  const hitNote = track.notes.find(n=> row===midiToRow(n.pitch) && step>=n.step && step<n.step+n.dur);
  if(!hitNote) return;
  pushHistory();
  track.notes = track.notes.filter(n=>n.id!==hitNote.id);
  selectedNoteIds.delete(hitNote.id);
  renderNotes(); buildOverview(); recomputeStepsTotal();
  e.stopPropagation(); e.preventDefault();
});

function onGridMouseDown(e){
  const track = selectedTrack(); if(!track) return;
  editContext = "notes";

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
      drag = {mode:"bend", noteId:note.id, startClientY:e.clientY, bendEngaged:false, allowBend: note.bendTo==null};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  // the small stub on a slurred note: drag it up/down to retarget the slur pitch without touching
  // the note's length (that stays the resize handle's job)
  if(e.target.classList && e.target.classList.contains("bendStub")){
    const note = track.notes.find(n=>n.id===Number(e.target.dataset.id));
    if(note){
      pushHistory();
      drag = {mode:"bendAdjust", noteId:note.id};
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
    if(!state.playing) previewNote(track, hitNote.pitch);
    if(!selectedNoteIds.has(hitNote.id)){
      if(!e.shiftKey) selectedNoteIds.clear();
      selectedNoteIds.add(hitNote.id);
      renderNotes();
    } else if(e.shiftKey){
      selectedNoteIds.delete(hitNote.id); renderNotes(); return;
    }
    pushHistory();
    const originNotes = track.notes.filter(n=>selectedNoteIds.has(n.id)).map(n=>({id:n.id, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null}));
    drag = {mode:"move", startStep:step, startMidiRow:row, origin:originNotes, moved:false, lastPreviewPitch:hitNote.pitch};
    e.preventDefault();
    return;
  }

  // empty cell: hold + drag sets a custom note length (start -> end point); a short click places the default length
  pushHistory();
  drag = {mode:"place", row, startStep:step, pitch:rowToMidi(row), downX:e.clientX, downY:e.clientY, dragged:false, noteId:null};
  e.preventDefault();
}

function previewNote(track, midi){
  playNote(track, midi, actx.currentTime+0.01, 0.18);
}

window.addEventListener("mousemove", (e)=>{
  if(loopDrag){
    const rect = document.getElementById("timelineInner").getBoundingClientRect();
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
    } else if(loopDrag.mode==="create"){
      if(!loopDrag.dragged && Math.abs(e.clientX-loopDrag.downX)>3) loopDrag.dragged = true;
      if(loopDrag.dragged){
        const cur = Math.round(stepAt);
        const s = Math.max(0, Math.min(loopDrag.startStep, cur));
        const en = Math.min(STEPS_TOTAL, Math.max(loopDrag.startStep, cur)+1);
        state.loop.start = s; state.loop.end = Math.max(s+1, en);
        state.loop.enabled = true;
        document.getElementById("loopBtn").classList.add("on");
      }
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
      buildOverview();
    }
    return;
  }
  if(playheadDrag){
    let step;
    if(playheadDrag.type==="grid"){
      const rect = gridInner.getBoundingClientRect();
      step = (e.clientX-rect.left)/STEP_W;
    } else {
      const rect = document.getElementById("timelineInner").getBoundingClientRect();
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
    const r0=Math.floor(top/ROW_H), r1=Math.ceil((top+h)/ROW_H);
    selectedNoteIds = new Set(drag.baseline);
    track.notes.forEach(n=>{
      const r = midiToRow(n.pitch);
      if(n.step+n.dur>s0 && n.step<s1 && r>=r0 && r<r1) selectedNoteIds.add(n.id);
    });
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
        }
      }

      renderNotes();
      const lenText = note.dur+" step"+(note.dur===1?"":"s");
      showTooltip(e.clientX, e.clientY, note.bendTo!=null ? lenText+" · slur to "+midiToName(note.bendTo) : lenText);
    }
  } else if(drag.mode==="bendAdjust"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      const clampedRow = Math.max(0, Math.min(TOTAL_ROWS-1, row));
      const newPitch = rowToMidi(clampedRow);
      if(newPitch !== (note.bendTo??note.pitch)){
        note.bendTo = newPitch===note.pitch ? null : newPitch;
        renderNotes();
      }
      showTooltip(e.clientX, e.clientY, note.bendTo!=null ? "slur to "+midiToName(note.bendTo) : "slur removed");
    }
  }
});
window.addEventListener("mouseup", ()=>{
  endHistoryGesture();
  if(loopDrag){ loopDrag=null; return; }
  if(trackDrag){ trackDrag=null; document.body.style.cursor=""; recomputeStepsTotal(); return; }
  if(playheadDrag){
    if(playheadDrag.type==="overview") suppressTimelineClick = true;
    playheadDrag=null;
    return;
  }
  if(drag){
    if(drag.mode==="select") document.getElementById("selectionBox").style.display="none";
    if(drag.mode==="move" && drag.moved){ buildOverview(); recomputeStepsTotal(); }
    if(drag.mode==="place"){
      const track = selectedTrack();
      if(track){
        if(!drag.dragged){
          const dur = noteOverlapMaxDur(track, drag.row, drag.startStep, state.noteLenSteps, null);
          const newNote = {id: nextNoteId++, step:drag.startStep, pitch:drag.pitch, dur, bendTo:null};
          track.notes.push(newNote);
          extendRegionsForNote(track, newNote);
          if(!state.playing) previewNote(track, drag.pitch);
          renderNotes();
        }
        buildOverview();
        recomputeStepsTotal();
      }
    }
    if(drag.mode==="bend" || drag.mode==="bendAdjust"){ buildOverview(); recomputeStepsTotal(); }
  }
  drag=null; hideTooltip();
});

// range sliders (volume/EQ/etc.) shouldn't keep keyboard focus after the drag ends —
// otherwise stray Delete/Backspace/arrow presses get eaten by the slider instead of the note editor
document.addEventListener("mouseup",(e)=>{
  if(e.target.tagName==="INPUT" && e.target.type==="range") e.target.blur();
});

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
        volume:track.volume, notes: track.notes.map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null})),
        regions: track.regions ? track.regions.map(r=>({start:r.start,end:r.end})) : null
      };
      if(k==="x"){
        pushHistory();
        state.tracks = state.tracks.filter(t=>t.id!==track.id);
        state.selectedTrackId = state.tracks.length? state.tracks[0].id : null;
        renderTrackList(); refreshInstrumentEditor(); renderNotes(); buildOverview();
        toast("Cut track \""+track.name+"\"");
      } else {
        toast("Copied track \""+track.name+"\"");
      }
    } else {
      if(!state.trackClipboard) return;
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

  const track = selectedTrack(); if(!track) return;

  if(editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="c"){
    state.clipboard = track.notes.filter(n=>selectedNoteIds.has(n.id)).map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null}));
    if(state.clipboard.length) toast("Copied "+state.clipboard.length+" note(s)");
    e.preventDefault();
  } else if(editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="x"){
    if(!selectedNoteIds.size) return;
    pushHistory();
    state.clipboard = track.notes.filter(n=>selectedNoteIds.has(n.id)).map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null}));
    track.notes = track.notes.filter(n=>!selectedNoteIds.has(n.id));
    selectedNoteIds.clear();
    renderNotes(); buildOverview();
    toast("Cut "+state.clipboard.length+" note(s)");
    e.preventDefault();
  } else if(editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="v"){
    if(!state.clipboard.length) return;
    pushHistory();
    const minStep = Math.min(...state.clipboard.map(n=>n.step));
    const pasteAt = Math.round(currentPlayStep());
    const newIds = [];
    state.clipboard.forEach(n=>{
      const id = nextNoteId++;
      const newNote = {id, step: pasteAt+(n.step-minStep), pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null};
      track.notes.push(newNote);
      extendRegionsForNote(track, newNote);
      newIds.push(id);
    });
    selectedNoteIds = new Set(newIds);
    renderNotes(); buildOverview(); recomputeStepsTotal();
    toast("Pasted "+newIds.length+" note(s) at step "+pasteAt);
    e.preventDefault();
  } else if(e.key==="Delete" || e.key==="Backspace"){
    if(selectedNoteIds.size){
      pushHistory();
      track.notes = track.notes.filter(n=>!selectedNoteIds.has(n.id));
      selectedNoteIds.clear(); renderNotes(); buildOverview();
      e.preventDefault();
    }
  } else if(e.key==="ArrowUp" && selectedNoteIds.size){
    pushHistory();
    track.notes.forEach(n=>{
      if(!selectedNoteIds.has(n.id)) return;
      const p = Math.min(127,n.pitch+1), r = midiToRow(p);
      if(!track.notes.some(o=>!selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && n.step<o.step+o.dur && n.step+n.dur>o.step)){
        if(n.bendTo!=null) n.bendTo = Math.min(127, n.bendTo+1);
        n.pitch=p;
      }
    });
    renderNotes(); e.preventDefault();
  } else if(e.key==="ArrowDown" && selectedNoteIds.size){
    pushHistory();
    track.notes.forEach(n=>{
      if(!selectedNoteIds.has(n.id)) return;
      const p = Math.max(0,n.pitch-1), r = midiToRow(p);
      if(!track.notes.some(o=>!selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && n.step<o.step+o.dur && n.step+n.dur>o.step)){
        if(n.bendTo!=null) n.bendTo = Math.max(0, n.bendTo-1);
        n.pitch=p;
      }
    });
    renderNotes(); e.preventDefault();
  } else if(e.key==="ArrowLeft" && selectedNoteIds.size){
    pushHistory();
    track.notes.forEach(n=>{
      if(!selectedNoteIds.has(n.id)) return;
      const s = Math.max(0,n.step-1), r = midiToRow(n.pitch);
      if(!track.notes.some(o=>!selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && s<o.step+o.dur && s+n.dur>o.step)) n.step=s;
    });
    renderNotes(); buildOverview(); e.preventDefault();
  } else if(e.key==="ArrowRight" && selectedNoteIds.size){
    pushHistory();
    track.notes.forEach(n=>{
      if(!selectedNoteIds.has(n.id)) return;
      const s = n.step+1, r = midiToRow(n.pitch);
      if(!track.notes.some(o=>!selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && s<o.step+o.dur && s+n.dur>o.step)) n.step=s;
    });
    renderNotes(); buildOverview(); recomputeStepsTotal(); e.preventDefault();
  } else if(e.code==="Space"){
    e.preventDefault();
    state.playing? stopPlayback(false) : startPlayback();
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

/* ======================================================================
   LOOP REGION INTERACTION
   ====================================================================== */
// the loop bar/region/handles now live in the arrange timeline and get rebuilt on every buildOverview() call,
// so listeners are delegated to the stable #timelineInner node rather than bound to the (transient) elements themselves
document.getElementById("timelineInner").addEventListener("mousedown",(e)=>{
  const rect = document.getElementById("timelineInner").getBoundingClientRect();
  const spb = stepsPerBar();
  if(e.target.id==="loopHandleL"){
    loopDrag = {mode:"resizeL"};
    e.preventDefault(); e.stopPropagation(); return;
  }
  if(e.target.id==="loopHandleR"){
    loopDrag = {mode:"resizeR"};
    e.preventDefault(); e.stopPropagation(); return;
  }
  if(e.target.id==="loopRegion"){
    loopDrag = {mode:"move", downStep:(e.clientX-rect.left)/BAR_PX*spb, startStart:state.loop.start, startEnd:state.loop.end};
    e.preventDefault(); e.stopPropagation(); return;
  }
  if(e.target.id==="loopBar"){
    const startStep = Math.max(0, Math.round((e.clientX-rect.left)/BAR_PX*spb));
    // only redefine the loop once the user actually drags — a bare click on empty ruler space
    // shouldn't collapse/replace whatever loop region is already set
    loopDrag = {mode:"create", downX:e.clientX, startStep, dragged:false};
    e.preventDefault(); e.stopPropagation(); return;
  }
});
document.getElementById("loopBtn").addEventListener("click",()=>{
  state.loop.enabled = !state.loop.enabled;
  document.getElementById("loopBtn").classList.toggle("on", state.loop.enabled);
  renderLoopUI();
  toast(state.loop.enabled ? "Loop on (step "+state.loop.start+"–"+state.loop.end+")" : "Loop off");
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

/* ======================================================================
   UNDO / REDO BUTTONS
   ====================================================================== */
document.getElementById("undoBtn").addEventListener("click", undo);
document.getElementById("redoBtn").addEventListener("click", redo);

/* ======================================================================
   TRACK LIST EVENTS (event delegation)
   ====================================================================== */
document.getElementById("trackList").addEventListener("click",(e)=>{
  const row = e.target.closest(".trackRow"); if(!row) return;
  const id = Number(row.dataset.id);
  const role = e.target.dataset.role;
  const track = state.tracks.find(t=>t.id===id);
  if(role==="mute"){ pushHistory(); track.muted=!track.muted; refreshAllTrackGains(); renderTrackList(); return; }
  if(role==="solo"){ pushHistory(); track.solo=!track.solo; refreshAllTrackGains(); renderTrackList(); return; }
  if(!role) selectTrack(id);
});
document.getElementById("trackList").addEventListener("mousedown",(e)=>{
  if(e.target.dataset.role==="vol") beginHistoryGesture();
});
document.getElementById("trackList").addEventListener("focusin",(e)=>{
  if(e.target.dataset.role==="name") beginHistoryGesture();
});
document.getElementById("trackList").addEventListener("focusout",(e)=>{
  if(e.target.dataset.role==="name") endHistoryGesture();
});
document.getElementById("trackList").addEventListener("input",(e)=>{
  const row = e.target.closest(".trackRow"); if(!row) return;
  const id = Number(row.dataset.id);
  const track = state.tracks.find(t=>t.id===id);
  const role = e.target.dataset.role;
  if(role==="name"){ track.name = e.target.value; buildOverview(); if(track.id===state.selectedTrackId) document.getElementById("instTrackName").textContent=track.name; }
  if(role==="vol"){ track.volume = e.target.value/100; refreshAllTrackGains(); if(track.id===state.selectedTrackId) refreshInstrumentEditor(); }
  if(role==="wave"){ pushHistory(); track.instrument.wave = e.target.value; if(track.id===state.selectedTrackId) refreshInstrumentEditor(); }
});
document.getElementById("timelineInner").addEventListener("click",(e)=>{
  if(suppressTimelineClick){ suppressTimelineClick=false; return; }
  const row = e.target.closest(".timelineRow"); if(!row) return;
  selectTrack(Number(row.dataset.id), {scrollToFirstNote:true});
});
document.getElementById("timelineCol").addEventListener("mousedown",(e)=>{
  const blockEl = e.target.closest(".overviewBlock");
  if(blockEl){
    const rowEl = e.target.closest(".timelineRow");
    const trackId = Number(rowEl.dataset.id);
    const track = state.tracks.find(t=>t.id===trackId);
    if(!track) return;
    const regionId = blockEl.dataset.regionId!=null ? Number(blockEl.dataset.regionId) : null;

    if(e.shiftKey && regionId!=null){
      // shift-click toggles this region into/out of the multi-selection, without starting a drag
      if(selectedRegionIds.has(regionId)) selectedRegionIds.delete(regionId);
      else selectedRegionIds.add(regionId);
      buildOverview();
      e.preventDefault(); e.stopPropagation();
      return;
    }
    selectedRegionIds = regionId!=null ? new Set([regionId]) : new Set();

    // clicking directly on a block rebuilds the timeline DOM synchronously (via selectTrack -> buildOverview),
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
  if(selectedRegionIds.size){ selectedRegionIds.clear(); buildOverview(); }
  const rect = document.getElementById("timelineInner").getBoundingClientRect();
  const x = e.clientX-rect.left;
  const phX = currentPlayStep()/stepsPerBar()*BAR_PX;
  if(Math.abs(x-phX)<=8){
    if(state.playing) stopPlayback(false);
    playheadDrag = {type:"overview"};
    e.preventDefault(); e.stopPropagation();
  }
});

// keep the track list and the arrange timeline scrolling together vertically
const trackListCol = document.getElementById("trackListCol");
const timelineCol = document.getElementById("timelineCol");
let syncingArrangeScroll = false;
trackListCol.addEventListener("scroll", ()=>{
  if(syncingArrangeScroll) return;
  syncingArrangeScroll = true;
  timelineCol.scrollTop = trackListCol.scrollTop;
  syncingArrangeScroll = false;
  positionOverviewFlag();
});
timelineCol.addEventListener("scroll", ()=>{
  if(syncingArrangeScroll) return;
  syncingArrangeScroll = true;
  trackListCol.scrollTop = timelineCol.scrollTop;
  syncingArrangeScroll = false;
  positionOverviewFlag();
});
document.getElementById("timelineCol").addEventListener("dblclick",(e)=>{
  const rect = document.getElementById("timelineInner").getBoundingClientRect();
  const x = e.clientX-rect.left;
  const step = Math.round(x/BAR_PX*stepsPerBar());
  state.playStartStep = Math.max(0,step); renderPlayheads();
  // scroll grid to same position
  gridScroll.scrollLeft = step*STEP_W-100;
});

document.getElementById("addTrackBtn").addEventListener("click", addTrack);
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
  renderTrackList(); buildOverview(); renderNotes();
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
  const t=selectedTrack(); if(!t) return; pushHistory(); t.instrument.wave=e.target.value; renderTrackList();
});
bindSlider("volSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.volume=v/100; document.getElementById("volVal").textContent=v; refreshAllTrackGains(); renderTrackList(); });
bindSlider("atkSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.attack=v; document.getElementById("atkVal").textContent=v+"ms"; });
bindSlider("relSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.release=v; document.getElementById("relVal").textContent=v+"ms"; });
bindSlider("eqLowSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.eqLow=v; document.getElementById("eqLowVal").textContent=v+"dB"; applyInstrumentToChain(t); });
bindSlider("eqMidSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.eqMid=v; document.getElementById("eqMidVal").textContent=v+"dB"; applyInstrumentToChain(t); });
bindSlider("eqHighSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.eqHigh=v; document.getElementById("eqHighVal").textContent=v+"dB"; applyInstrumentToChain(t); });
bindSlider("revSlider",(v)=>{ const t=selectedTrack(); if(!t)return; t.instrument.reverb=v; document.getElementById("revVal").textContent=v+"%"; applyInstrumentToChain(t); });

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
      track.instrument.customBuffer = buf;
      track.instrument.wave = "custom";
      document.getElementById("waveSel").value="custom";
      document.getElementById("sampleName").textContent = file.name;
      renderTrackList();
      toast("Loaded sample: "+file.name);
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
  const [a,b] = e.target.value.split("/").map(Number); state.timeSig=[a,b]; drawGridLines(); buildOverview();
});
document.getElementById("noteLenSel").addEventListener("change",(e)=>{ state.noteLenSteps = Number(e.target.value); });
document.getElementById("keySel").addEventListener("change",(e)=>{ state.key=e.target.value; buildPianoLabels(); drawGridLines(); });
document.getElementById("modeSel").addEventListener("change",(e)=>{ state.mode=e.target.value; buildPianoLabels(); drawGridLines(); });
document.getElementById("octaveSel").addEventListener("change",(e)=>{
  state.octaveFocus = Number(e.target.value);
  const midi=(state.octaveFocus+1)*12;
  gridScroll.scrollTop = midiToRow(midi)*ROW_H - gridScroll.clientHeight/2;
  syncPianoScroll();
});

document.getElementById("playBtn").addEventListener("click", ()=> state.playing? stopPlayback(false) : startPlayback());
document.getElementById("stopBtn").addEventListener("click", ()=> stopPlayback(true));

function syncPianoScroll(){
  document.getElementById("pianoColInner").style.transform = "translateY("+(-gridScroll.scrollTop)+"px)";
}
gridScroll.addEventListener("scroll", syncPianoScroll);

/* ======================================================================
   SAVE / LOAD / NEW
   ====================================================================== */
function serializeProject(){
  return {
    bpm: state.bpm, timeSig: state.timeSig, key: state.key, mode: state.mode,
    octaveFocus: state.octaveFocus, noteLenSteps: state.noteLenSteps,
    tracks: state.tracks.map(t=>({
      id:t.id, name:t.name, color:t.color, muted:t.muted, solo:t.solo, volume:t.volume,
      instrument: { wave:t.instrument.wave, volume:t.instrument.volume, attack:t.instrument.attack,
        release:t.instrument.release, eqLow:t.instrument.eqLow, eqMid:t.instrument.eqMid,
        eqHigh:t.instrument.eqHigh, reverb:t.instrument.reverb, customBaseMidi:t.instrument.customBaseMidi },
      notes: t.notes.map(n=>({id:n.id, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null})),
      regions: t.regions ? t.regions.map(r=>({id:r.id, start:r.start, end:r.end})) : null
    }))
  };
}
document.getElementById("saveBtn").addEventListener("click", ()=>{
  const data = JSON.stringify(serializeProject(), null, 1);
  const blob = new Blob([data], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "Bit Beats Project.json"; a.click();
  toast("Project saved");
});
document.getElementById("loadBtn").addEventListener("click", ()=> document.getElementById("loadInput").click());
document.getElementById("loadInput").addEventListener("change",(e)=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      loadProject(data);
      toast("Project loaded");
    }catch(err){ toast("Invalid project file"); }
  };
  reader.readAsText(file);
  e.target.value="";
});
function loadProject(data){
  STEPS_TOTAL = STEPS_TOTAL_BASE;
  state.bpm=data.bpm||120; state.timeSig=data.timeSig||[4,4]; state.key=data.key||"C"; state.mode=data.mode||"Major";
  state.octaveFocus=data.octaveFocus||4; state.noteLenSteps=data.noteLenSteps||4;
  document.getElementById("bpmInput").value=state.bpm;
  document.getElementById("timeSigSel").value=state.timeSig.join("/");
  document.getElementById("keySel").value=state.key; document.getElementById("modeSel").value=state.mode;
  document.getElementById("octaveSel").value=state.octaveFocus;
  document.getElementById("noteLenSel").value=state.noteLenSteps;
  nextTrackId=1; nextNoteId=1;
  state.tracks = (data.tracks||[]).map(t=>{
    const track = makeTrack(t.name, 0);
    track.id = t.id||nextTrackId; nextTrackId=Math.max(nextTrackId, track.id+1);
    track.color = t.color||track.color; track.muted=!!t.muted; track.solo=!!t.solo; track.volume = t.volume??0.8;
    track.instrument = Object.assign(defaultInstrument(), t.instrument||{});
    track.notes = (t.notes||[]).map(n=>{ nextNoteId=Math.max(nextNoteId, (n.id||0)+1); return {id:n.id||nextNoteId++, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null}; });
    track.regions = (t.regions||null) && t.regions.map(r=>{ nextNoteId=Math.max(nextNoteId, (r.id||0)+1); return {id:r.id||nextNoteId++, start:r.start, end:r.end}; });
    buildChain(track);
    return track;
  });
  state.selectedTrackId = state.tracks.length? state.tracks[0].id : null;
  selectedNoteIds.clear(); selectedRegionIds.clear();
  undoStack=[]; redoStack=[];
  state.loop = {enabled:false, start:0, end:stepsPerBar()};
  sizeGrid(); buildPianoLabels(); drawGridLines();
  renderTrackList(); refreshInstrumentEditor(); renderNotes(); buildOverview();
  recomputeStepsTotal();
  document.getElementById("loopBtn").classList.remove("on");
}
document.getElementById("newBtn").addEventListener("click", ()=>{
  if(!confirm("Start a new project? Unsaved changes will be lost.")) return;
  stopPlayback(true);
  STEPS_TOTAL = STEPS_TOTAL_BASE;
  state.tracks=[]; state.selectedTrackId=null; selectedNoteIds.clear(); selectedRegionIds.clear();
  undoStack=[]; redoStack=[];
  initDefaultProject();
});

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
  sizeGrid(); buildPianoLabels();
  const t1 = makeTrack("Lead Square",0); buildChain(t1); state.tracks.push(t1);
  const t2 = makeTrack("Bass Triangle",1); t2.instrument.wave="triangle"; buildChain(t2); state.tracks.push(t2);
  state.selectedTrackId = t1.id;
  renderTrackList(); refreshInstrumentEditor(); renderNotes(); buildOverview();
  const midi=(state.octaveFocus+1)*12;
  gridScroll.scrollTop = midiToRow(midi)*ROW_H - gridScroll.clientHeight/2;
  syncPianoScroll();
  renderPlayheads();
}
window.addEventListener("resize", ()=>{});
initDefaultProject();

})();

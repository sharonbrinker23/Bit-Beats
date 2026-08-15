/* Bit Beats — the instrument editor panel, plus selecting / adding / deleting a track
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { GRID_RULER_H, ROW_H, selectedAutoPointIds, state, actx, gridScroll } = BB;
const makeTrack = (...a)=> BB.makeTrack(...a), selectedTrack = (...a)=> BB.selectedTrack(...a),
      applySampleToTrack = (...a)=> BB.applySampleToTrack(...a), findSample = (...a)=> BB.findSample(...a),
      registerSample = (...a)=> BB.registerSample(...a),
      beginHistoryGesture = (...a)=> BB.beginHistoryGesture(...a), pushHistory = (...a)=> BB.pushHistory(...a),
      applyInstrumentToChain = (...a)=> BB.applyInstrumentToChain(...a),
      buildChain = (...a)=> BB.buildChain(...a), refreshAllTrackGains = (...a)=> BB.refreshAllTrackGains(...a),
      midiToRow = (...a)=> BB.midiToRow(...a), renderNotes = (...a)=> BB.renderNotes(...a),
      syncPianoScroll = (...a)=> BB.syncPianoScroll(...a),
      applyWaveSelection = (...a)=> BB.applyWaveSelection(...a),
      centerSelectedInstrumentRow = (...a)=> BB.centerSelectedInstrumentRow(...a),
      fitInstTopRow = (...a)=> BB.fitInstTopRow(...a),
      renderInstrumentList = (...a)=> BB.renderInstrumentList(...a),
      syncWaveCustomOptions = (...a)=> BB.syncWaveCustomOptions(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a),
      renderSamplePanel = (...a)=> BB.renderSamplePanel(...a),
      updateSampleMenuBtn = (...a)=> BB.updateSampleMenuBtn(...a), toast = (...a)=> BB.toast(...a);
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
  BB.editContext = "track";
  BB.selectedNoteIds.clear();
  BB.phantomSelection = null;
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
  gridScroll.scrollLeft = Math.max(0, firstNote.step*BB.STEP_W - 40);
  const row = midiToRow(firstNote.pitch);
  gridScroll.scrollTop = Math.max(0, row*ROW_H+GRID_RULER_H - gridScroll.clientHeight/2);
  syncPianoScroll();
}
// the phantom cell spans state.noteLenSteps steps, so its start has to stop far enough from the right
// edge that the whole span still fits inside the grid
function clampPhantomStep(step){
  return Math.max(0, Math.min(step, BB.STEPS_TOTAL - state.noteLenSteps));
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
  if(track && BB.selectedNoteIds.size){
    const notes = track.notes.filter(n=>BB.selectedNoteIds.has(n.id));
    if(!notes.length) return;
    notes.forEach(n=>{
      const row = midiToRow(n.pitch);
      const l = n.step*BB.STEP_W, r = (n.step+n.dur)*BB.STEP_W;
      const t = row*ROW_H + GRID_RULER_H, b = t + ROW_H;
      boxLeft = boxLeft==null ? l : Math.min(boxLeft, l);
      boxRight = boxRight==null ? r : Math.max(boxRight, r);
      boxTop = boxTop==null ? t : Math.min(boxTop, t);
      boxBottom = boxBottom==null ? b : Math.max(boxBottom, b);
    });
  } else if(BB.phantomSelection){
    boxLeft = BB.phantomSelection.step*BB.STEP_W;
    boxRight = (BB.phantomSelection.step+state.noteLenSteps)*BB.STEP_W;
    boxTop = BB.phantomSelection.row*ROW_H + GRID_RULER_H;
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
  const t = makeTrack("Track "+BB.nextTrackId, state.tracks.length);
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

/* exported to the shared namespace */
Object.assign(BB, { addTrack, clampPhantomStep, deleteSelectedTrack, refreshInstrumentEditor,
                    scrollSelectionIntoView, selectTrack });
})();

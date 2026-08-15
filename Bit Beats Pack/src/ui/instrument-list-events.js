/* Bit Beats — instrument-row events, the track colour picker, arrange-view events
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { TRACK_COLORS, state, gridScroll } = BB;
const selectedTrack = (...a)=> BB.selectedTrack(...a),
      beginHistoryGesture = (...a)=> BB.beginHistoryGesture(...a),
      dropCheckpoint = (...a)=> BB.dropCheckpoint(...a),
      endHistoryGesture = (...a)=> BB.endHistoryGesture(...a), pushHistory = (...a)=> BB.pushHistory(...a),
      refreshAllTrackGains = (...a)=> BB.refreshAllTrackGains(...a),
      renderNotes = (...a)=> BB.renderNotes(...a), stepsPerBar = (...a)=> BB.stepsPerBar(...a),
      currentPlayStep = (...a)=> BB.currentPlayStep(...a),
      positionTrackListFlag = (...a)=> BB.positionTrackListFlag(...a),
      renderPlayheads = (...a)=> BB.renderPlayheads(...a), stopPlayback = (...a)=> BB.stopPlayback(...a),
      applyWaveSelection = (...a)=> BB.applyWaveSelection(...a),
      applyWaveTier = (...a)=> BB.applyWaveTier(...a), buildTrackList = (...a)=> BB.buildTrackList(...a),
      fitRowControls = (...a)=> BB.fitRowControls(...a),
      renderInstrumentList = (...a)=> BB.renderInstrumentList(...a),
      setTrackRowHeight = (...a)=> BB.setTrackRowHeight(...a), setTrackZoom = (...a)=> BB.setTrackZoom(...a),
      sizeNameInput = (...a)=> BB.sizeNameInput(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a), addTrack = (...a)=> BB.addTrack(...a),
      deleteSelectedTrack = (...a)=> BB.deleteSelectedTrack(...a),
      refreshInstrumentEditor = (...a)=> BB.refreshInstrumentEditor(...a),
      selectTrack = (...a)=> BB.selectTrack(...a), toast = (...a)=> BB.toast(...a);
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
  if(BB.suppressTrackListClick){ BB.suppressTrackListClick=false; return; }
  const row = e.target.closest(".trackRow"); if(!row) return;
  selectTrack(Number(row.dataset.id), {scrollToFirstNote:true});
});
document.getElementById("trackListCol").addEventListener("mousedown",(e)=>{
  if(e.target.closest("#trackListRuler")){
    if(state.playing) stopPlayback(false);
    const rect = document.getElementById("trackListInner").getBoundingClientRect();
    state.playStartStep = Math.max(0, Math.min(BB.STEPS_TOTAL, (e.clientX-rect.left)/BB.BAR_PX*stepsPerBar()));
    BB.playheadDrag = {type:"trackList"};
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
      if(BB.selectedRegionIds.has(regionId)) BB.selectedRegionIds.delete(regionId);
      else BB.selectedRegionIds.add(regionId);
      buildTrackList();
      e.preventDefault(); e.stopPropagation();
      return;
    }
    BB.selectedRegionIds = regionId!=null ? new Set([regionId]) : new Set();

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
      BB.trackDrag = {
        trackId, startX:e.clientX, minDelta, maxDelta,
        origin: track.notes.filter(n=> n.step>=region.start && n.step<region.end).map(n=>({id:n.id, step:n.step})),
        originRegions: [{id:region.id, start:region.start, end:region.end}]
      };
    } else {
      // un-split track: the whole thing (all notes) drags together, as before
      BB.trackDrag = {
        trackId, startX:e.clientX, minDelta:-Infinity, maxDelta:Infinity,
        origin: track.notes.map(n=>({id:n.id, step:n.step})),
        originRegions: track.regions ? track.regions.map(r=>({id:r.id, start:r.start, end:r.end})) : null
      };
    }
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if(BB.selectedRegionIds.size){ BB.selectedRegionIds.clear(); buildTrackList(); }
  const rect = document.getElementById("trackListInner").getBoundingClientRect();
  const x = e.clientX-rect.left;
  const phX = currentPlayStep()/stepsPerBar()*BB.BAR_PX;
  if(Math.abs(x-phX)<=8){
    if(state.playing) stopPlayback(false);
    BB.playheadDrag = {type:"trackList"};
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
  const step = Math.round(x/BB.BAR_PX*stepsPerBar());
  state.playStartStep = Math.max(0,step); renderPlayheads();
  // scroll grid to same position
  gridScroll.scrollLeft = step*BB.STEP_W-100;
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
    track.regions = [{id: BB.nextNoteId++, start: Math.floor(minStep/spb)*spb, end: Math.ceil(maxStep/spb)*spb}];
  }
  const idx = track.regions.findIndex(r=> splitStep>r.start && splitStep<r.end);
  if(idx===-1){
    dropCheckpoint(); // nothing actually changed — drop the checkpoint we just pushed
    toast("Playhead must be inside a region of \""+track.name+"\" to split it");
    return;
  }
  const region = track.regions[idx];
  const left = {id: BB.nextNoteId++, start:region.start, end:splitStep};
  const right = {id: BB.nextNoteId++, start:splitStep, end:region.end};
  track.regions.splice(idx, 1, left, right);
  renderInstrumentList(); buildTrackList(); renderNotes();
  toast("Split \""+track.name+"\" at step "+splitStep);
});

/* exported to the shared namespace */
Object.assign(BB, { hexToRgb });
})();

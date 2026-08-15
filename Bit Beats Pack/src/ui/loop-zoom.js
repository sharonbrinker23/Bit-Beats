/* Bit Beats — loop-region dragging, pinch/slider zoom, the undo/redo buttons
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { state, gridScroll } = BB;
const redo = (...a)=> BB.redo(...a), undo = (...a)=> BB.undo(...a), setZoom = (...a)=> BB.setZoom(...a),
      stepsPerBar = (...a)=> BB.stepsPerBar(...a), currentPlayStep = (...a)=> BB.currentPlayStep(...a),
      renderLoopUI = (...a)=> BB.renderLoopUI(...a), renderPlayheads = (...a)=> BB.renderPlayheads(...a),
      stopPlayback = (...a)=> BB.stopPlayback(...a), setTrackZoom = (...a)=> BB.setTrackZoom(...a),
      toast = (...a)=> BB.toast(...a);
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
  const phX = currentPlayStep()/spb*BB.BAR_PX;
  if(Math.abs(x-phX)<=8){
    if(state.playing) stopPlayback(false);
    BB.playheadDrag = {type:"trackList"};
    e.preventDefault(); e.stopPropagation();
    return;
  }

  const regionLeftPx = state.loop.start/spb*BB.BAR_PX;
  const regionRightPx = state.loop.end/spb*BB.BAR_PX;
  // resize handles get a forgiving pixel-tolerance hit zone around the loop's edges, rather than
  // relying on landing exactly on the thin 7px handle element
  const tolerance = 6;
  if(Math.abs(x-regionLeftPx) <= tolerance){
    BB.loopDrag = {mode:"resizeL"};
    e.preventDefault(); e.stopPropagation(); return;
  }
  if(Math.abs(x-regionRightPx) <= tolerance){
    BB.loopDrag = {mode:"resizeR"};
    e.preventDefault(); e.stopPropagation(); return;
  }
  if(x>regionLeftPx && x<regionRightPx){
    BB.loopDrag = {mode:"move", downStep:x/BB.BAR_PX*spb, startStart:state.loop.start, startEnd:state.loop.end};
    e.preventDefault(); e.stopPropagation(); return;
  }
  // Clicking the bar's empty background (not a handle, not inside the existing region) moves the
  // playhead there in ONE click and starts a drag, exactly like #trackListRuler and #gridRuler do.
  // It deliberately does NOT spin up a brand new loop region the way it once did — that made the
  // playhead flag nearly impossible to grab, since a click a few pixels off target started drawing
  // a loop instead. Loop editing stays confined to the handles and the region body (handled above).
  if(state.playing) stopPlayback(false);
  state.playStartStep = Math.max(0, Math.min(BB.STEPS_TOTAL, x/BB.BAR_PX*spb));
  BB.playheadDrag = {type:"trackList"};
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
  setZoom(BB.STEP_W*Math.exp(-e.deltaY*0.01));
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
  setTrackZoom(BB.BAR_PX*Math.exp(-e.deltaY*0.01));
},{passive:false});

/* ======================================================================
   UNDO / REDO BUTTONS
   ====================================================================== */
document.getElementById("undoBtn").addEventListener("click", undo);
document.getElementById("redoBtn").addEventListener("click", redo);
})();

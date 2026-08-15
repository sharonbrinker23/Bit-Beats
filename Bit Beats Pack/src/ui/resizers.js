/* Bit Beats — draggable panel resizers and the toast
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const fitInstTopRow = (...a)=> BB.fitInstTopRow(...a), fitRowControls = (...a)=> BB.fitRowControls(...a),
      sizeNameInput = (...a)=> BB.sizeNameInput(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a);
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

/* exported to the shared namespace */
Object.assign(BB, { toast });
})();

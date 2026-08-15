/* Bit Beats — undo / redo: snapshotting tracks and restoring them
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { selectedAutoPointIds, state } = BB;
const defaultAutomation = (...a)=> BB.defaultAutomation(...a),
      resolveTrackSample = (...a)=> BB.resolveTrackSample(...a), buildChain = (...a)=> BB.buildChain(...a),
      buildPianoLabels = (...a)=> BB.buildPianoLabels(...a), drawGridLines = (...a)=> BB.drawGridLines(...a),
      recomputeStepsTotal = (...a)=> BB.recomputeStepsTotal(...a), renderNotes = (...a)=> BB.renderNotes(...a),
      buildTrackList = (...a)=> BB.buildTrackList(...a),
      renderInstrumentList = (...a)=> BB.renderInstrumentList(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a),
      refreshInstrumentEditor = (...a)=> BB.refreshInstrumentEditor(...a),
      renderChordPalette = (...a)=> BB.renderChordPalette(...a), toast = (...a)=> BB.toast(...a);
/* ======================================================================
   UNDO / REDO
   ====================================================================== */
// the two stacks are private to this file. Everything outside it goes through pushHistory/undo/redo or
// through the three helpers just below, so no other file has to know a checkpoint is an array entry.
let undoStack = [], redoStack = [];
let historyArmed = false;
// how deep the undo stack is, and dropping its most recent entry — the idiom several callers reach for
// when an operation turns out to have changed nothing, so its checkpoint would be pure clutter
function historyDepth(){ return undoStack.length; }
function dropCheckpoint(){ undoStack.pop(); }
// a freshly loaded (or brand new) project has no past: both stacks go, rather than leaving the previous
// project's checkpoints restorable over the top of this one
function resetHistory(){ undoStack = []; redoStack = []; }
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
    BB.nextTrackId = Math.max(BB.nextTrackId, track.id+1);
    track.notes.forEach(n=>{ BB.nextNoteId = Math.max(BB.nextNoteId, n.id+1); });
    Object.values(track.automation).forEach(pts=> pts.forEach(p=>{ BB.nextNoteId = Math.max(BB.nextNoteId, p.id+1); }));
    // the registry itself is deliberately NOT snapshotted (an upload is an asset, not an edit, so undo
    // must not un-import it) — the snapshot only carries sampleId, and this puts the buffer back
    resolveTrackSample(track);
    buildChain(track);
    return track;
  });
  // a provisional paste (see BB.pendingPasteIds) names notes by id, and every note object above was
  // just rebuilt from the snapshot — the ids it is holding either no longer exist or now belong to a
  // note this restore put back, neither of which is the group the user was still moving. So the group
  // is abandoned here rather than judged, and undo can never leave a pending set pointing at ghosts.
  BB.pendingPasteIds = new Set(); BB.pendingPasteTrackId = null;
  BB.selectedNoteIds.clear(); BB.selectedRegionIds.clear(); selectedAutoPointIds.clear(); BB.phantomSelection = null;
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

/* exported to the shared namespace */
Object.assign(BB, { beginHistoryGesture, cloneAutomation, dropCheckpoint, endHistoryGesture, historyDepth,
                    pushHistory, redo, resetHistory, undo });
})();

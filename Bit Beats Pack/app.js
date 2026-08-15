/* Bit Beats — entry point: boots the default project (loaded last)
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { GRID_RULER_H, ROW_H, state, gridScroll } = BB;
const makeTrack = (...a)=> BB.makeTrack(...a), buildChain = (...a)=> BB.buildChain(...a),
      buildPianoLabels = (...a)=> BB.buildPianoLabels(...a), midiToRow = (...a)=> BB.midiToRow(...a),
      renderNotes = (...a)=> BB.renderNotes(...a), sizeGrid = (...a)=> BB.sizeGrid(...a),
      syncPianoScroll = (...a)=> BB.syncPianoScroll(...a), renderPlayheads = (...a)=> BB.renderPlayheads(...a),
      buildTrackList = (...a)=> BB.buildTrackList(...a), fitInstTopRow = (...a)=> BB.fitInstTopRow(...a),
      renderInstrumentList = (...a)=> BB.renderInstrumentList(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a),
      refreshInstrumentEditor = (...a)=> BB.refreshInstrumentEditor(...a),
      renderProjectTitle = (...a)=> BB.renderProjectTitle(...a),
      syncSubHeaderLayout = (...a)=> BB.syncSubHeaderLayout(...a),
      renderSamplePanel = (...a)=> BB.renderSamplePanel(...a),
      syncDockedPanels = (...a)=> BB.syncDockedPanels(...a);
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

/* exported to the shared namespace */
Object.assign(BB, { initDefaultProject });
})();

/* Bit Beats — the project's registry of uploaded audio samples
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { state } = BB;
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
  const entry = {id: BB.nextSampleId++, name: (name||"Sample").trim() || "Sample", buffer};
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

/* exported to the shared namespace */
Object.assign(BB, { applySampleToTrack, findSample, registerSample, resolveTrackSample });
})();

/* Bit Beats — the project document (tracks, notes, transport settings) and the app-wide selections
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { TRACK_COLORS } = BB;
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
/* ---------- a pasted group that had nowhere legal to land ----------
   Pasting into a spot that is blocked all the way to the top of the grid drops the new tiles ON TOP of
   the existing ones rather than silently refusing, but that overlap is provisional: the group stays
   selected so the user can move it somewhere legal, and whichever of its notes is still overlapping
   when the selection moves on is thrown away instead of being left buried under an older tile. The
   track id rides along because the group can only be judged against the notes it actually landed
   among — if that track (or the whole project) is gone by then there is nothing left to judge and the
   group is simply forgotten. resolvePendingPaste() in note-editing.js is the contract itself. */
BB.pendingPasteIds = new Set();
BB.pendingPasteTrackId = null;

/* ---------- the note selection reports every change it undergoes ----------
   A provisional paste has to be judged the instant it stops being selected, and notes get deselected
   from a dozen places across the app: clicking empty grid, rubber-banding, selecting another tile,
   Escape, switching tracks, clicking a track block, deleting, undo, loading a project. Rather than
   trusting every one of them to remember a rule that has nothing to do with what it was written for,
   the selection itself announces its mutations. The check runs once at the END of the turn that
   changed it, never mid-flight — a click that clears the selection and then re-adds one tile has not
   deselected anything, and reading the set halfway through that would say otherwise. */
let selectionCheckQueued = false;
function scheduleSelectionCheck(){
  if(selectionCheckQueued || !BB.pendingPasteIds.size) return;
  selectionCheckQueued = true;
  Promise.resolve().then(()=>{
    selectionCheckQueued = false;
    if(BB.resolvePendingPaste) BB.resolvePendingPaste();
  });
}
class NoteSelection extends Set {
  add(id){ const set = super.add(id); scheduleSelectionCheck(); return set; }
  delete(id){ const gone = super.delete(id); if(gone) scheduleSelectionCheck(); return gone; }
  clear(){ if(this.size) scheduleSelectionCheck(); super.clear(); }
}
// the wrapper is an invariant, not a convention: two selection paths REPLACE the set wholesale rather
// than mutating it, and a plain `new Set(...)` landing here would switch the reporting off for good —
// so the namespace re-wraps whatever it is handed instead of taking it on trust.
let noteSelection = new NoteSelection();
Object.defineProperty(BB, "selectedNoteIds", {
  enumerable:true, configurable:true,
  get(){ return noteSelection; },
  set(ids){ noteSelection = (ids instanceof NoteSelection) ? ids : new NoteSelection(ids||[]); scheduleSelectionCheck(); }
});
BB.selectedRegionIds = new Set(); // shift-selected split-region blocks in the track list
let selectedAutoPointIds = new Set(); // selected automation dots in the advanced track editor
// {step,row} of an empty grid cell "selected" via double-click, purely for keyboard navigation — lets
// arrow keys explore empty cells without creating or moving any real note. Mutually exclusive with
// selectedNoteIds: entering/exiting always keeps exactly one of the two non-empty (never both)
BB.phantomSelection = null;
// tracks a note that was just placed by a single, un-dragged click on an empty cell — a genuine
// double-click on empty space fires that same placement (via the first click) followed immediately by
// this dblclick handler seeing a "hit" note that only exists because of it. Within a short window this
// is treated as a no-op double-click on empty space (toggling phantom mode) rather than a real
// double-click-to-delete of a pre-existing note.
BB.justPlacedNoteId = null; BB.justPlacedAt = 0;
const JUST_PLACED_WINDOW_MS = 700;
BB.nextTrackId=1; BB.nextNoteId=1; BB.nextSampleId=1;
BB.editContext = "notes"; // "notes" or "track" — decides what Ctrl+C/Ctrl+V act on
// throttles Ctrl+V so holding/mashing it can't fire dozens of paste-and-rerender cycles a second
let lastPasteAt = 0;
const PASTE_COOLDOWN_MS = 200;
function pasteOnCooldown(){
  const now = performance.now();
  if(now-lastPasteAt < PASTE_COOLDOWN_MS) return true;
  lastPasteAt = now;
  return false;
}

/* ---------- asking the state a question ----------
   The three lookups that were being repeated verbatim in half a dozen files, kept next to the state
   they read: a caller asks which track is selected / which one the advanced editor is on / whether
   anything is soloed, instead of walking state.tracks itself. */

function selectedTrack(){ return state.tracks.find(t=>t.id===state.selectedTrackId); }

function advTrack(){ return state.tracks.find(t=>t.id===state.advancedTrackId); }

function anySolo(){ return state.tracks.some(t=>t.solo); }

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
  return { id: BB.nextTrackId++, name: name||("Track "+BB.nextTrackId), color: TRACK_COLORS[colorIdx % TRACK_COLORS.length],
           instrument: defaultInstrument(), notes: [], muted:false, solo:false, volume:0.8, pan:50, regions:null,
           automation: defaultAutomation() };
}

/* exported to the shared namespace */
Object.assign(BB, { advTrack, anySolo, defaultAutomation, defaultInstrument, JUST_PLACED_WINDOW_MS, makeTrack,
                    pasteOnCooldown, selectedAutoPointIds, selectedTrack, state });
})();

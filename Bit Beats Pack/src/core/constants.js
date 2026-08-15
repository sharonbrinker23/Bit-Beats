/* Bit Beats — grid geometry, the note-name/scale tables, and pure midi<->name/frequency maths
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* ======================================================================
   CONSTANTS / MUSIC THEORY
   ====================================================================== */
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const OCT_MIN = 0, OCT_MAX = 7;
const ROW_H = 18;
const GRID_RULER_H = 18; // reserved band at the top of the piano roll for the bar-number ruler — real
// space (not an overlay), so no note row ever shares pixels with it; must match #gridRuler's CSS height
BB.STEP_W = 26;
const STEP_W_MIN = 5, STEP_W_MAX = 70;
const STEPS_TOTAL_BASE = 256; // 16th-note steps available on the grid (~16 bars @4/4)
BB.STEPS_TOTAL = STEPS_TOTAL_BASE; // grows automatically as content extends past the current end
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

/* exported to the shared namespace */
Object.assign(BB, { GRID_RULER_H, midiToFreq, midiToName, NOTE_NAMES, OCT_MAX, OCT_MIN, ROW_H, SCALES,
                    STEP_W_MAX, STEP_W_MIN, STEPS_TOTAL_BASE, TRACK_COLORS });
})();

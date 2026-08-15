/* Bit Beats — the dockable side panels: chord palette and custom sample manager
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { NOTE_NAMES, SCALES, state, actx, TOP_MIDI, TOTAL_ROWS } = BB;
const selectedTrack = (...a)=> BB.selectedTrack(...a), findSample = (...a)=> BB.findSample(...a),
      pushHistory = (...a)=> BB.pushHistory(...a), liveTarget = (...a)=> BB.liveTarget(...a),
      playNote = (...a)=> BB.playNote(...a), extendRegionsForNote = (...a)=> BB.extendRegionsForNote(...a),
      midiToRow = (...a)=> BB.midiToRow(...a), recomputeStepsTotal = (...a)=> BB.recomputeStepsTotal(...a),
      renderNotes = (...a)=> BB.renderNotes(...a), currentPlayStep = (...a)=> BB.currentPlayStep(...a),
      buildTrackList = (...a)=> BB.buildTrackList(...a), fitInstTopRow = (...a)=> BB.fitInstTopRow(...a),
      renderInstrumentList = (...a)=> BB.renderInstrumentList(...a),
      refreshInstrumentEditor = (...a)=> BB.refreshInstrumentEditor(...a),
      scrollSelectionIntoView = (...a)=> BB.scrollSelectionIntoView(...a),
      noteOverlapMaxDur = (...a)=> BB.noteOverlapMaxDur(...a),
      selectNotesExclusively = (...a)=> BB.selectNotesExclusively(...a), toast = (...a)=> BB.toast(...a);
/* ======================================================================
   DOCKABLE SIDE PANELS

   A "dock panel" is a menu with two homes. While the advanced track editor is CLOSED it floats as a
   dropdown under its own trigger button (the #colorPicker treatment). While the editor is OPEN the very
   same element is re-parented into one of the editor's dock slots, so the two menus sit side by side in
   one card instead of one covering the other. Toggling the editor has to move it live, in both
   directions, which is why this is a registry rather than three lines inside the chord panel's own code:
   the custom-sample-list panel is going to want exactly this behaviour in #advDockRight.

   To add a panel: give it a body-level element, then call registerDockPanel({...}) once. Nothing else —
   renderAdvancedEditor() already calls syncDockedPanels() on every open/close/resize of the editor.
   The element must not assume a parent: it keeps its children across the move, and only the
   .floating / .docked class swaps (style.css owns what each of those two looks like).
   ====================================================================== */
const DOCK_PANELS = []; // {panelId, slotId, anchorId, isOpen()}
function registerDockPanel(cfg){ DOCK_PANELS.push(cfg); return cfg; }

function placeDockPanel(cfg){
  const el = document.getElementById(cfg.panelId);
  const slot = document.getElementById(cfg.slotId);
  if(!el || !slot) return;
  // a closed panel hides its slot too, so an unused dock contributes neither width nor a divider line
  if(!cfg.isOpen()){ el.classList.add("hidden"); slot.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  // read off the editor's own .hidden class rather than state.advancedTrackId: renderAdvancedEditor()
  // sets that class first and calls us second, so this is always the state the user can actually see
  const advOpen = !document.getElementById("advancedEditor").classList.contains("hidden");
  if(advOpen){
    if(el.parentNode!==slot) slot.appendChild(el);
    slot.classList.remove("hidden");
    el.classList.remove("floating"); el.classList.add("docked");
    el.style.left = ""; el.style.top = ""; // the fixed-position coords would survive the class swap otherwise
  } else {
    if(el.parentNode!==document.body) document.body.appendChild(el);
    slot.classList.add("hidden");
    el.classList.remove("docked"); el.classList.add("floating");
    const anchor = document.getElementById(cfg.anchorId);
    if(anchor){
      const rect = anchor.getBoundingClientRect();
      // measured AFTER .floating is applied, since that is the class that gives the panel its width.
      // Anchored by its RIGHT edge because these triggers live at the right end of the sub-header —
      // left-anchoring a 250px card there would hang it off the side of the window.
      const w = el.offsetWidth || 252;
      const left = Math.max(8, Math.min(rect.right-w, window.innerWidth-w-8));
      el.style.left = Math.round(left)+"px";
      el.style.top = Math.round(rect.bottom+6)+"px";
    }
  }
}
function syncDockedPanels(){ DOCK_PANELS.forEach(placeDockPanel); }

/* ======================================================================
   CHORD PALETTE

   Picking a root / quality / scale degree lights the panel up AND auditions the chord; the Add button
   in the head is the one thing here that writes to state.tracks. The chord NAMES are still derived
   separately from the pitches, because a palette that showed the wrong spelling for the current key
   would be useless to look at even when it plays the right notes.
   ====================================================================== */
// `intervals` are semitones above the root, and they are what both the preview and Add read — the
// suffix is only ever printed.
//
// 11 and 13 are the two that cannot be a literal stack of every third, so this table follows the
// standard jazz omissions:
//   * 11 DROPS THE 3rd -> [0,7,10,14,17]. Over a dominant the natural 11 sits a semitone above the
//     major 3rd, and that ♭9 rub between two chord tones is the one interval the voicing exists to
//     avoid; dropping the 3rd is why an 11 chord is so often just voiced as a sus.
//   * 13 DROPS THE 11th -> [0,4,7,10,14,21]. Here it is the 3rd that survives (it is what makes the
//     chord dominant rather than sus) and the 11th that goes, for the same clash seen from the other
//     side. The 13 is written +21 rather than +9 so it stacks ABOVE the 9th instead of folding back
//     underneath it as a 6th — a 13 chord that voices its extension below its 7th is a 6/9 chord.
const CHORD_QUALITIES = [
  {id:"maj",  label:"maj",  suffix:"",     intervals:[0,4,7]},
  {id:"min",  label:"min",  suffix:"m",    intervals:[0,3,7]},
  {id:"dim",  label:"dim",  suffix:"dim",  intervals:[0,3,6]},
  {id:"aug",  label:"aug",  suffix:"aug",  intervals:[0,4,8]},
  {id:"sus2", label:"sus2", suffix:"sus2", intervals:[0,2,7]},
  {id:"sus4", label:"sus4", suffix:"sus4", intervals:[0,5,7]},
  {id:"6",    label:"6",    suffix:"6",    intervals:[0,4,7,9]},
  {id:"m6",   label:"m6",   suffix:"m6",   intervals:[0,3,7,9]},
  {id:"7",    label:"7",    suffix:"7",    intervals:[0,4,7,10]},
  {id:"maj7", label:"maj7", suffix:"maj7", intervals:[0,4,7,11]},
  {id:"m7",   label:"m7",   suffix:"m7",   intervals:[0,3,7,10]},
  {id:"m7b5", label:"m7♭5", suffix:"m7♭5", intervals:[0,3,6,10]},
  {id:"dim7", label:"dim7", suffix:"dim7", intervals:[0,3,6,9]},
  {id:"9",    label:"9",    suffix:"9",    intervals:[0,4,7,10,14]},
  {id:"maj9", label:"maj9", suffix:"maj9", intervals:[0,4,7,11,14]},
  {id:"m9",   label:"m9",   suffix:"m9",   intervals:[0,3,7,10,14]},
  {id:"add9", label:"add9", suffix:"add9", intervals:[0,4,7,14]},
  {id:"11",   label:"11",   suffix:"11",   intervals:[0,7,10,14,17]},
  {id:"13",   label:"13",   suffix:"13",   intervals:[0,4,7,10,14,21]}
];
// same substitution buildPianoLabels() makes: "#" is an ASCII stand-in stored in NOTE_NAMES, "♯" is
// what a musician reads, and the palette is pure display so it always shows the real glyph
function noteLabel(n){ return n.replace("#","♯"); }
function qualitySuffix(id){ const q = CHORD_QUALITIES.find(x=>x.id===id); return q ? q.suffix : ""; }
function chordIntervals(id){ const q = CHORD_QUALITIES.find(x=>x.id===id); return q ? q.intervals : CHORD_QUALITIES[0].intervals; }

// The one place a palette selection becomes actual MIDI. `octave` is the Octave dropdown's value, so
// the root lands on the same C the keyboard focus is already parked at and the extensions of a 9/11/13
// stack up from there rather than being folded back into a single octave — a chord you add should look
// on the grid like the chord you would have voiced by hand.
//
// The high end of a 13 sits 21 semitones over its root, so at Octave 7 it genuinely runs off the top of
// the drawable range. Out-of-range tones are clamped exactly as importMidiTracks and the mode-switch
// clamp do, and then de-duplicated: clamping collapses several tones onto the top row, and two notes on
// one row would be stacked tiles, which is the one thing Add must never produce.
function chordPitches(rootName, qualityId, octave){
  const pc = NOTE_NAMES.indexOf(rootName);
  if(pc<0) return [];
  const LOW_MIDI = TOP_MIDI-TOTAL_ROWS+1;
  const base = (octave+1)*12 + pc;
  const out = [];
  chordIntervals(qualityId).forEach(semi=>{
    const midi = Math.max(LOW_MIDI, Math.min(TOP_MIDI, base+semi));
    if(!out.includes(midi)) out.push(midi);
  });
  return out;
}

// Works out what each scale degree's triad is CALLED in the current key/mode by stacking scale thirds
// and reading the resulting interval pattern — a major third + perfect fifth is a major triad and gets
// an upper-case numeral, a minor third + diminished fifth is "vii°", and so on. No pitches leave this
// function; it only ever returns strings for the palette to print.
function diatonicChords(){
  const keyIdx = Math.max(0, NOTE_NAMES.indexOf(state.key));
  const raw = SCALES[state.mode] || SCALES.Major;
  // Chromatic has all twelve notes and therefore no scale degrees to stack thirds on, so the palette
  // falls back to the parallel major — the same seven chords a player would reach for over it anyway
  const sc = raw.length===7 ? raw : SCALES.Major;
  const ROMAN = ["I","II","III","IV","V","VI","VII"];
  return sc.map((_,i)=>{
    // degree i+k, carrying the +12 for every time the stack wraps past the top of the scale
    const at = k=> sc[(i+k)%7] + 12*Math.floor((i+k)/7);
    const third = at(2)-at(0), fifth = at(4)-at(0);
    let quality = "maj", mark = "", roman = ROMAN[i];
    if(third===3 && fifth===6){ quality="dim"; mark="°"; roman=roman.toLowerCase(); }
    else if(third===3){ quality="min"; roman=roman.toLowerCase(); }
    else if(fifth===8){ quality="aug"; mark="+"; }
    const root = NOTE_NAMES[(keyIdx+sc[i])%12];
    return {root, quality, degree:roman+mark, name:noteLabel(root)+qualitySuffix(quality)};
  });
}

let chordMenuOpen = false;
// purely local to this panel — read by nothing outside it, and deliberately not part of `state` (it is
// UI position, not project data, so it stays out of save files and out of undo/redo)
let chordSel = {root:null, quality:"maj", degree:null};
// until the user picks a root by hand the root row tracks the Key select, so the palette opens already
// pointing at the key you are working in; once they choose one it stops moving under them
let chordRootTouched = false;
// the chord the palette is currently pointing at, resolved through the same fallback renderChordPalette
// paints with, so what you hear and what you add can never disagree with what is highlighted
function chordSelPitches(){ return chordPitches(chordSel.root||state.key, chordSel.quality, state.octaveFocus); }
function chordSelName(){ return noteLabel(chordSel.root||state.key)+qualitySuffix(chordSel.quality); }

// A palette click is an audition, so it rings a little longer than previewNote's 0.18s tap — a triad
// cut off that fast reads as a click rather than as a chord — but only a little, because the point is
// to hear the quality, not to sustain a pad.
const CHORD_PREVIEW_SEC = 0.5;
// exactly one chord sounding at a time, the same discipline samplePreviewSrc enforces for the sample
// manager: mashing along the quality grid must swap one chord for the next, not pile fifteen voices on
// top of each other. Stored per-voice rather than as a flag because a chord is up to six of them.
let chordPreviewVoices = [];
function stopChordPreview(){
  if(!chordPreviewVoices.length) return;
  const now = actx.currentTime;
  // same two-step silence silenceAllVoices uses: kill the envelope first so nothing clicks, then stop
  // the source. Either can throw on a voice that already finished, and a finished voice is already
  // silent, so there is genuinely nothing to do about a failure.
  chordPreviewVoices.forEach(v=>{
    try{ v.env.gain.cancelScheduledValues(now); v.env.gain.setValueAtTime(0, now); }catch(_){}
    try{ v.source.stop(now); }catch(_){}
  });
  chordPreviewVoices = [];
}
function previewChord(){
  // the piano roll's own previews are guarded the same way: auditioning a chord over a running
  // transport would just be a wrong note in the middle of the take
  if(state.playing) return;
  const track = selectedTrack(); if(!track) return;
  const pitches = chordSelPitches(); if(!pitches.length) return;
  // nothing sounds at all until a gesture has unlocked the context, and the palette click IS that
  // gesture on a freshly loaded page
  if(actx.state==="suspended") actx.resume();
  stopChordPreview();
  // ONE startTime for the whole chord — computed before the loop, so the tones are simultaneous rather
  // than a very fast arpeggio of whatever actx.currentTime crept to between calls
  const at = actx.currentTime+0.01;
  pitches.forEach(midi=>{
    playNote(track, {midi, startTime: at, durSec: CHORD_PREVIEW_SEC, bendToMidi: null}, liveTarget(track));
    // playNote doesn't hand its voice back, but it appends exactly one entry to activeVoices for every
    // live (non-render) call, so the tail of that array is the voice just created. Holding the record
    // itself is safe across the filter/reassign playNote does to prune finished voices.
    const v = BB.activeVoices[BB.activeVoices.length-1];
    if(v) chordPreviewVoices.push(v);
  });
}

function buildChordPalette(){
  const rootGrid = document.getElementById("chordRootGrid");
  NOTE_NAMES.forEach(n=>{
    const b = document.createElement("button");
    b.className = "chordBtn"; b.dataset.root = n; b.textContent = noteLabel(n);
    rootGrid.appendChild(b);
  });
  const qGrid = document.getElementById("chordQualityGrid");
  CHORD_QUALITIES.forEach(q=>{
    const b = document.createElement("button");
    b.className = "chordBtn"; b.dataset.quality = q.id; b.textContent = q.label;
    qGrid.appendChild(b);
  });
}

function renderChordPalette(){
  if(!chordRootTouched) chordSel.root = state.key;
  document.getElementById("chordKeyLabel").textContent = noteLabel(state.key)+" "+state.mode;
  // the button's face can only ever say "Add" at this size, so the chord it would actually write goes
  // in the tooltip — refreshed here so it can never name the chord that was selected a click ago
  document.getElementById("chordAddBtn").title =
    "Add "+chordSelName()+" to the selected track at the cursor (or the playhead)";

  document.querySelectorAll("#chordRootGrid .chordBtn").forEach(b=>{
    b.classList.toggle("active", b.dataset.root===chordSel.root);
  });
  // the title is the only place the two axes are shown combined, which is what makes a bare "m7" button
  // legible as "the chord you would get is Gm7" without the panel having to spell it out in the grid
  document.querySelectorAll("#chordQualityGrid .chordBtn").forEach(b=>{
    b.classList.toggle("active", b.dataset.quality===chordSel.quality);
    b.title = noteLabel(chordSel.root||state.key)+qualitySuffix(b.dataset.quality);
  });

  const grid = document.getElementById("chordDiatonicGrid");
  const chords = diatonicChords();
  grid.title = (SCALES[state.mode]||[]).length===7
    ? ("Diatonic chords of "+noteLabel(state.key)+" "+state.mode)
    : ("Chromatic has no scale degrees — showing "+noteLabel(state.key)+" Major");
  grid.innerHTML = "";
  chords.forEach((c,i)=>{
    const b = document.createElement("button");
    b.className = "chordBtn chordDegBtn"+(chordSel.degree===i?" active":"");
    b.dataset.degree = i;
    b.title = c.name;
    const deg = document.createElement("span"); deg.className="deg"; deg.textContent = c.degree;
    const nm = document.createElement("span"); nm.className="nm"; nm.textContent = c.name;
    b.appendChild(deg); b.appendChild(nm);
    grid.appendChild(b);
  });
}

// Writes the selected chord into the piano roll: one tile per chord tone, every tile starting on the
// same step and running state.noteLenSteps, which is what makes the stack sound as a chord rather than
// as a figure. Everything after the plan is the same bookkeeping a normal click-placement does in the
// mouseup handler's drag.mode==="place" branch.
function addChordToRoll(){
  const track = selectedTrack();
  if(!track){ toast("Select a track first"); return; }
  const pitches = chordSelPitches();
  if(!pitches.length){ toast("That chord has no playable notes here"); return; }

  // WHERE IN TIME: the dashed empty-cell cursor is a position the user placed deliberately, so it wins
  // outright when it exists. With none set, the playhead is the only other "here" on screen — and it is
  // a float while the transport runs, so it is rounded to a whole step. Clamped so the chord's own left
  // edge can never start past the end of the grid (recomputeStepsTotal grows the grid for the tail).
  const rawStep = BB.phantomSelection ? BB.phantomSelection.step : currentPlayStep();
  const step = Math.max(0, Math.min(Math.round(rawStep), Math.max(0, BB.STEPS_TOTAL-1)));

  // Plan first, commit second: a chord whose every row is already occupied must not leave an empty
  // undo checkpoint behind, so pushHistory() only happens once there is something to push.
  const plan = []; let skipped = 0, shortened = 0;
  pitches.forEach(midi=>{
    const row = midiToRow(midi);
    // noteOverlapMaxDur only looks FORWARD from `step`, so a note already spanning `step` is invisible
    // to it — that case is the "row is completely blocked" one and has to be caught separately here
    const covered = track.notes.some(n=> midiToRow(n.pitch)===row && step>=n.step && step<n.step+n.dur);
    if(covered){ skipped++; return; }
    const dur = noteOverlapMaxDur(track, row, step, state.noteLenSteps, null);
    if(dur < state.noteLenSteps) shortened++;
    plan.push({midi, dur});
  });
  if(!plan.length){ toast("No room for "+chordSelName()+" there — those rows are already taken"); return; }

  pushHistory();
  const ids = [];
  plan.forEach(p=>{
    const note = {id: BB.nextNoteId++, step, pitch:p.midi, dur:p.dur, bendTo:null};
    track.notes.push(note);
    extendRegionsForNote(track, note);
    ids.push(note.id);
  });
  // the chord becomes the selection and nothing else is left selected, so the whole stack can be
  // retyped from the Note Length dropdown or nudged as one unit straight after adding it
  selectNotesExclusively(ids, true);
  renderNotes(); buildTrackList(); recomputeStepsTotal();
  scrollSelectionIntoView();

  // silence beats a silent failure: a partially-added chord looks like a bug unless it says why
  if(skipped || shortened){
    const parts = [];
    if(skipped) parts.push(skipped+" note"+(skipped>1?"s":"")+" skipped");
    if(shortened) parts.push(shortened+" shortened");
    toast("Added "+chordSelName()+" — "+parts.join(", ")+" (rows already in use)");
  }
}

function closeChordMenu(){
  chordMenuOpen = false;
  document.getElementById("chordMenuBtn").classList.remove("on");
  syncDockedPanels();
}

document.getElementById("chordMenuBtn").addEventListener("click",()=>{
  chordMenuOpen = !chordMenuOpen;
  document.getElementById("chordMenuBtn").classList.toggle("on", chordMenuOpen);
  if(chordMenuOpen) renderChordPalette();
  syncDockedPanels();
});
// Picking is still selection-only as far as the PROJECT is concerned — no note is written and nothing
// is transposed — but every pick now auditions the resulting chord, so the three grids can be browsed
// by ear. Picking a root or a quality drops the scale-degree highlight because the degree tile stands
// for a specific root+quality pair that no longer holds; picking a degree lights its own root and
// quality back up, so the three rows always agree with each other. previewChord() runs after the
// re-render in each case, so it always sounds whatever the panel has just finished highlighting.
document.getElementById("chordRootGrid").addEventListener("click",(e)=>{
  const b = e.target.closest(".chordBtn"); if(!b) return;
  chordSel.root = b.dataset.root; chordSel.degree = null; chordRootTouched = true;
  renderChordPalette(); previewChord();
});
document.getElementById("chordQualityGrid").addEventListener("click",(e)=>{
  const b = e.target.closest(".chordBtn"); if(!b) return;
  chordSel.quality = b.dataset.quality; chordSel.degree = null;
  renderChordPalette(); previewChord();
});
document.getElementById("chordDiatonicGrid").addEventListener("click",(e)=>{
  const b = e.target.closest(".chordBtn"); if(!b) return;
  const c = diatonicChords()[Number(b.dataset.degree)]; if(!c) return;
  chordSel.degree = Number(b.dataset.degree);
  chordSel.root = c.root; chordSel.quality = c.quality; chordRootTouched = true;
  renderChordPalette(); previewChord();
});
// Add does NOT preview: the chord it writes is about to be visible on the grid, and the roll's own
// placement preview convention is one voice per placed note, not a second copy of what was just heard
document.getElementById("chordAddBtn").addEventListener("click", addChordToRoll);
// outside-click dismissal is the FLOATING presentation's rule only (mirroring closeColorPicker's
// handler). Docked, the panel is a column of the advanced editor like #advTabs is — clicking a note in
// the roll must no more close it than it closes the automation lane beside it.
document.addEventListener("mousedown",(e)=>{
  if(!chordMenuOpen) return;
  const el = document.getElementById("chordPanel");
  if(!el.classList.contains("floating")) return;
  // the whole #chordMenuWrap is exempt, not just the button: the wrap's label.field caption forwards its
  // click to the button (that is what a <label> around a labelable control does), but the mousedown that
  // precedes it targets the LABEL. Guarding only the button would close the menu here and then let the
  // forwarded click immediately re-open it, so a caption click could never dismiss the palette.
  if(e.target.closest("#chordPanel") || e.target.closest("#chordMenuWrap")) return;
  closeChordMenu();
});
// added as a SEPARATE listener rather than folded into the #keySel / #modeSel handlers above, so the
// palette's label refresh cannot collide with whatever else those two selects grow to do. Registered
// after them, so state.key / state.mode are already updated by the time this runs.
["keySel","modeSel"].forEach(id=>{
  document.getElementById(id).addEventListener("change", ()=>{ renderChordPalette(); });
});

buildChordPalette();
renderChordPalette();
registerDockPanel({panelId:"chordPanel", slotId:"advDockLeft", anchorId:"chordMenuBtn", isOpen:()=>chordMenuOpen});

/* ======================================================================
   CUSTOM SAMPLE MANAGER

   The registry's second face: a list of the project's uploads where a row is exactly a gray play button
   and the sample's title. The title renames in place using the same idiom as instrument names and the
   project title (plain text, swapped for a bordered <input> on double-click, committed on Enter/blur) —
   and because the waveform dropdowns label their options from state.samples, a rename lands in both of
   them at once.

   Its trigger lives beside #uploadSampleBtn and only exists once there is something to manage. The panel
   is a dock panel (see registerDockPanel above): a dropdown under that button while the advanced editor
   is closed, and docked into #advDockRight — right of the automation lane, behind the light-gray
   divider — while it is open.
   ====================================================================== */
BB.sampleMenuOpen = false;
// exactly one preview voice at a time: clicking play again (or on another row) replaces the one that is
// sounding instead of layering another copy on top of it
let samplePreviewSrc = null;
function stopSamplePreview(){
  if(!samplePreviewSrc) return;
  // stop() on a source that already ran to the end throws in some engines, and the only thing that
  // matters here is that a still-sounding one goes quiet — so a failure is genuinely nothing to do
  try{ samplePreviewSrc.onended = null; samplePreviewSrc.stop(); }catch(_){}
  samplePreviewSrc = null;
}
function previewSample(id){
  const s = findSample(id);
  // a registry entry with no buffer is reachable: a project loaded from JSON knows a sampleId but the
  // save file never carried the audio, so there is nothing decoded to play
  if(!s || !s.buffer){ toast("That sample has no audio loaded"); return; }
  if(actx.state==="suspended") actx.resume();
  stopSamplePreview();
  const src = actx.createBufferSource(); src.buffer = s.buffer;
  const g = actx.createGain(); g.gain.value = 0.9;
  // straight to the destination, deliberately NOT through a track's chain: this auditions the FILE, so
  // it must not arrive coloured by whichever track's EQ, reverb and volume happen to point at it
  src.connect(g); g.connect(actx.destination);
  src.onended = ()=>{ if(samplePreviewSrc===src) samplePreviewSrc = null; };
  src.start();
  samplePreviewSrc = src;
}

// the trigger exists only while the registry has something in it, and an empty registry also forces the
// panel shut, so it can never be left hanging open over a list with no rows
function updateSampleMenuBtn(){
  const btn = document.getElementById("sampleMenuBtn");
  if(!btn) return;
  const has = state.samples.length>0;
  if(!has && BB.sampleMenuOpen){ BB.sampleMenuOpen = false; stopSamplePreview(); }
  btn.classList.toggle("hidden", !has);
  btn.classList.toggle("on", BB.sampleMenuOpen);
  fitInstTopRow(); // the row just gained or lost a button, so its label budget changed
}
function closeSampleMenu(){
  BB.sampleMenuOpen = false;
  document.getElementById("sampleMenuBtn").classList.remove("on");
  stopSamplePreview();
  syncDockedPanels();
}

function renderSamplePanel(){
  const list = document.getElementById("sampleList");
  if(!list) return;
  const n = state.samples.length;
  document.getElementById("sampleCountLabel").textContent = n ? (n+(n===1?" file":" files")) : "";
  list.innerHTML = "";
  state.samples.forEach(s=>{
    const row = document.createElement("div");
    row.className = "sampleRow"; row.dataset.id = s.id;
    row.innerHTML = `
      <button class="samplePlayBtn" data-role="samplePlay" title="Preview this sample">&#9654;</button>
      <span class="sampleNameText" data-role="sampleNameText" title="Double-click to rename">${escapeHtml(s.name)}</span>`;
    list.appendChild(row);
  });
  updateSampleMenuBtn();
  syncDockedPanels();
}

/* ---------- rename a sample: double-click, exactly like an instrument name ----------
   A plain "dblclick" listener is enough here (unlike the instrument list, which has to detect its own
   double-click from e.detail): clicking a sample row selects nothing and rebuilds nothing, so the span
   the first click landed on is still the same node when the second one arrives. */
function beginSampleNameEdit(span){
  const row = span.closest(".sampleRow"); if(!row) return;
  const s = findSample(Number(row.dataset.id)); if(!s) return;
  const input = document.createElement("input");
  input.type = "text"; input.dataset.role = "sampleName"; input.value = s.name;
  const commit = ()=>{
    if(!input.isConnected) return; // re-entry guard: renderSamplePanel below removes the input, which blurs it
    const name = input.value.trim();
    if(name && name!==s.name){
      s.name = name;
      // the dropdowns are the whole point of renaming, so push the new label into both of them now,
      // each re-fitted to its own select's width, rather than waiting for some unrelated rerender
      renderInstrumentList();
      refreshInstrumentEditor();
    }
    renderSamplePanel();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown",(e)=>{
    if(e.key==="Enter"){ commit(); e.preventDefault(); }
    else if(e.key==="Escape"){ input.value = s.name; commit(); e.preventDefault(); }
    // the app-wide shortcuts (Delete, arrows, Ctrl+Z) must not act on keys typed into a name field
    e.stopPropagation();
  });
  span.replaceWith(input);
  input.focus(); input.select();
}

document.getElementById("sampleMenuBtn").addEventListener("click",()=>{
  if(!state.samples.length) return;
  BB.sampleMenuOpen = !BB.sampleMenuOpen;
  document.getElementById("sampleMenuBtn").classList.toggle("on", BB.sampleMenuOpen);
  if(BB.sampleMenuOpen) renderSamplePanel(); else stopSamplePreview();
  syncDockedPanels();
});
document.getElementById("samplePanel").addEventListener("click",(e)=>{
  const btn = e.target.closest("[data-role=samplePlay]"); if(!btn) return;
  const row = btn.closest(".sampleRow"); if(!row) return;
  previewSample(Number(row.dataset.id));
});
document.getElementById("samplePanel").addEventListener("dblclick",(e)=>{
  const span = e.target.closest("[data-role=sampleNameText]"); if(!span) return;
  beginSampleNameEdit(span);
  e.preventDefault(); e.stopPropagation();
});
// outside-click dismissal belongs to the FLOATING presentation only, exactly as it does for the chord
// palette: docked, this panel is a column of the advanced editor and clicking the piano roll must no
// more close it than it closes the automation lane beside it
document.addEventListener("mousedown",(e)=>{
  if(!BB.sampleMenuOpen) return;
  const el = document.getElementById("samplePanel");
  if(!el.classList.contains("floating")) return;
  if(e.target.closest("#samplePanel") || e.target.closest("#sampleMenuBtn")) return;
  closeSampleMenu();
});
registerDockPanel({panelId:"samplePanel", slotId:"advDockRight", anchorId:"sampleMenuBtn",
  isOpen:()=> BB.sampleMenuOpen && state.samples.length>0});

/* exported to the shared namespace */
Object.assign(BB, { renderChordPalette, renderSamplePanel, stopSamplePreview, syncDockedPanels,
                    updateSampleMenuBtn });
})();

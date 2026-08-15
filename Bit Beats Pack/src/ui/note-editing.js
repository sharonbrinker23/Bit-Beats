/* Bit Beats — every mouse and keyboard gesture that edits notes on the grid
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { GRID_RULER_H, ROW_H, JUST_PLACED_WINDOW_MS, selectedAutoPointIds, state, actx, TOTAL_ROWS, gridCanvas,
        gridInner, gridScroll, noteLayer } = BB;
const midiToName = (...a)=> BB.midiToName(...a), advTrack = (...a)=> BB.advTrack(...a),
      makeTrack = (...a)=> BB.makeTrack(...a), pasteOnCooldown = (...a)=> BB.pasteOnCooldown(...a),
      selectedTrack = (...a)=> BB.selectedTrack(...a), dropCheckpoint = (...a)=> BB.dropCheckpoint(...a),
      endHistoryGesture = (...a)=> BB.endHistoryGesture(...a), historyDepth = (...a)=> BB.historyDepth(...a),
      pushHistory = (...a)=> BB.pushHistory(...a), redo = (...a)=> BB.redo(...a),
      undo = (...a)=> BB.undo(...a), buildChain = (...a)=> BB.buildChain(...a),
      liveTarget = (...a)=> BB.liveTarget(...a), playNote = (...a)=> BB.playNote(...a),
      clampedBendStartStep = (...a)=> BB.clampedBendStartStep(...a),
      extendRegionsForNote = (...a)=> BB.extendRegionsForNote(...a), midiToRow = (...a)=> BB.midiToRow(...a),
      recomputeStepsTotal = (...a)=> BB.recomputeStepsTotal(...a), renderNotes = (...a)=> BB.renderNotes(...a),
      rowToMidi = (...a)=> BB.rowToMidi(...a), stepsPerBar = (...a)=> BB.stepsPerBar(...a),
      currentPlayStep = (...a)=> BB.currentPlayStep(...a), renderLoopUI = (...a)=> BB.renderLoopUI(...a),
      renderPlayheads = (...a)=> BB.renderPlayheads(...a), stopPlayback = (...a)=> BB.stopPlayback(...a),
      togglePlayPause = (...a)=> BB.togglePlayPause(...a), buildTrackList = (...a)=> BB.buildTrackList(...a),
      renderInstrumentList = (...a)=> BB.renderInstrumentList(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a),
      clampPhantomStep = (...a)=> BB.clampPhantomStep(...a),
      deleteSelectedTrack = (...a)=> BB.deleteSelectedTrack(...a),
      refreshInstrumentEditor = (...a)=> BB.refreshInstrumentEditor(...a),
      scrollSelectionIntoView = (...a)=> BB.scrollSelectionIntoView(...a),
      selectTrack = (...a)=> BB.selectTrack(...a), toast = (...a)=> BB.toast(...a);
/* ======================================================================
   NOTE EDITING: click-add, drag-select, drag-move, copy/paste
   ====================================================================== */
let drag = null; // {mode:'select'|'move'|'place', startX,startY, origin notes...}
BB.playheadDrag = null; // {type:'grid'|'trackList'}
BB.loopDrag = null; // {mode:'move'|'resizeL'|'resizeR', ...}
BB.trackDrag = null; // {trackId, startX, origin}
BB.suppressTrackListClick = false;

// true only while the current note selection is the one PLACEMENT itself just made — see the
// empty-cell branch of onGridMouseDown, which has to keep placing notes on consecutive clicks now
// that placing one selects it
let selectionFromPlacement = false;

/* ---------- selecting a note tile is exclusive across the whole app ----------
   Region blocks in the track list, automation dots in the advanced editor, the phantom keyboard cursor
   and a focused button/dropdown/slider all answer the same question — "what does the next keypress act
   on?" — so exactly one of them may be lit at a time, and a note tile winning clears the rest.
   Each panel is only re-rendered when its own selection actually had something in it, so the common
   case (clicking tile after tile with nothing else selected) stays a plain renderNotes(). */
function clearNonNoteSelections(){
  if(BB.selectedRegionIds.size){ BB.selectedRegionIds.clear(); buildTrackList(); }
  if(selectedAutoPointIds.size){ selectedAutoPointIds.clear(); renderAdvancedEditor(); }
  // the phantom cell is already mutually exclusive with selectedNoteIds; clearing it here is what
  // makes that invariant hold for every selection path rather than only the ones that remembered to
  BB.phantomSelection = null;
  selectionFromPlacement = false;
  blurFocusedControl();
}
// replaces the note selection with exactly `ids` and nothing else, anywhere in the app. Callers that
// ADD to the existing selection (shift-click, rubber band) set selectedNoteIds themselves and call
// clearNonNoteSelections() instead. Neither renders the notes — every caller already does.
function selectNotesExclusively(ids, fromPlacement){
  BB.selectedNoteIds = new Set(ids);
  clearNonNoteSelections();
  selectionFromPlacement = !!fromPlacement;
}

function xyToStepRow(clientX, clientY){
  const rect = gridInner.getBoundingClientRect();
  const x = clientX-rect.left, y = clientY-rect.top;
  // x/y stay raw (gridInner-relative) since that's the same coordinate space the note layer and
  // selection box already render in (both pushed down by GRID_RULER_H via CSS) — only the row index
  // needs the ruler's reserved band subtracted out before dividing into row units
  return { step: Math.floor(x/BB.STEP_W), row: Math.floor((y-GRID_RULER_H)/ROW_H), x, y };
}

// largest duration (in steps) startable at `step` in `row` before hitting the next note, so tiles never overlap
function noteOverlapMaxDur(track, row, step, desiredDur, excludeId){
  let maxDur = desiredDur;
  track.notes.forEach(n=>{
    if(n.id===excludeId) return;
    if(midiToRow(n.pitch)===row && n.step>step){
      maxDur = Math.min(maxDur, n.step-step);
    }
  });
  return Math.max(1, maxDur);
}

// earliest step a note can be trimmed back to from the left, given its right edge stays fixed at
// `fixedEnd` — the mirror of noteOverlapMaxDur, so trimming from the left can't cross an earlier tile
function noteOverlapMinStep(track, row, fixedEnd, excludeId){
  let minStep = 0;
  track.notes.forEach(n=>{
    if(n.id===excludeId) return;
    if(midiToRow(n.pitch)===row && n.step+n.dur<=fixedEnd){
      minStep = Math.max(minStep, n.step+n.dur);
    }
  });
  return Math.min(minStep, fixedEnd-1);
}

// two tiles occupy the same space when they sit on the same pitch (a pitch apart IS a row apart, so
// that is never a collision) and their half-open [step, step+dur) spans overlap
function notesCollide(a, b){
  return a.pitch===b.pitch && a.step < b.step+b.dur && a.step+a.dur > b.step;
}

/* ---------- a pasted group never lands inside an existing tile ----------
   When the landing site is occupied the WHOLE group climbs one semitone and is re-tested as a unit —
   never a note at a time — so what gets placed is the chord the user copied, its voicing and its step
   offsets intact, rather than a pile of notes squeezed individually into whichever gaps happened to be
   free. The first offset that clears is the one taken, so the group moves as little as it can.
   The climb stops at the top of the grid, because there is no row above row 0 to climb to: the search
   is bounded by the highest tile's own headroom and returns null when nothing in that range is clear.
   A null is not a refusal — see beginPendingPaste for what the paste does with it. */
function findClearTransposition(track, landing){
  const headroom = rowToMidi(0) - Math.max(...landing.map(n=>n.pitch));
  for(let up=0; up<=headroom; up++){
    const blocked = landing.some(c=> track.notes.some(n=> notesCollide({pitch:c.pitch+up, step:c.step, dur:c.dur}, n)));
    if(!blocked) return up;
  }
  return null;
}
// keeps a transposed slur target on a row the grid can actually draw, the same clamp mode switching
// applies to the pitches it moves
function clampToGrid(midi){ return Math.max(rowToMidi(TOTAL_ROWS-1), Math.min(rowToMidi(0), midi)); }

/* ---------- the other half of the provisional-paste contract ----------
   A paste that had nowhere clear to go lands on top of what was already there and stays selected, on
   the understanding that the user will move it. This is where that understanding is settled, the
   moment the group stops being the selection by ANY route (BB.selectedNoteIds reports its own changes
   precisely so no route can skip this). Each pasted note is judged on its own: one that has been moved
   clear becomes an ordinary note, and one that is still sitting inside a note that was already on the
   track is deleted — the older tile is the one that was there first and is never touched. A sibling
   from the same paste is not something worth being discarded over, so the group is judged against
   everything EXCEPT itself.
   The discard deliberately gets no checkpoint of its own: pushHistory() already ran for the paste, and
   folding the two together means one Ctrl+Z takes the user back to before a paste that turned out to
   leave nothing behind — including the regions and step count the paste stretched on its way in, which
   a discard alone could not walk back. */
function resolvePendingPaste(){
  if(!BB.pendingPasteIds.size) return;
  let stillSelected = true;
  BB.pendingPasteIds.forEach(id=>{ if(!BB.selectedNoteIds.has(id)) stillSelected = false; });
  if(stillSelected) return; // still the user's to move; nothing is decided yet
  const pending = BB.pendingPasteIds;
  const track = state.tracks.find(t=>t.id===BB.pendingPasteTrackId);
  BB.pendingPasteIds = new Set(); BB.pendingPasteTrackId = null;
  if(!track) return; // the track, or the whole project, went away — there is nothing left to judge
  // pasted notes the user has since deleted simply aren't here any more, which is its own answer
  const alive = track.notes.filter(n=>pending.has(n.id));
  const doomed = new Set(alive.filter(n=> track.notes.some(o=> !pending.has(o.id) && notesCollide(n,o))).map(n=>n.id));
  if(!doomed.size) return;
  track.notes = track.notes.filter(n=>!doomed.has(n.id));
  doomed.forEach(id=> BB.selectedNoteIds.delete(id));
  renderNotes(); buildTrackList(); recomputeStepsTotal();
  toast("Discarded "+doomed.size+" overlapping pasted note(s)");
}
function beginPendingPaste(ids, trackId){
  // exactly one group is ever pending: a second provisional paste means the first one's moment has
  // already passed (it is not the selection any more), so it is settled here and now rather than
  // having its ids quietly forgotten under the new group's
  resolvePendingPaste();
  BB.pendingPasteIds = new Set(ids);
  BB.pendingPasteTrackId = trackId;
}

noteLayer.addEventListener("mousedown", onGridMouseDown);
gridCanvas.addEventListener("mousedown", onGridMouseDown);

// double-click a tile to delete it; double-click empty space to toggle phantom (keyboard-only)
// navigation of empty cells on and off
noteLayer.addEventListener("dblclick", (e)=>{
  const track = selectedTrack(); if(!track) return;
  const {step,row} = xyToStepRow(e.clientX,e.clientY);
  const hitNote = track.notes.find(n=> row===midiToRow(n.pitch) && step>=n.step && step<n.step+n.dur);
  // a double-click's own first click already ran onGridMouseDown's empty-cell "place" logic and created
  // a note before this handler ever saw the cell — so a real double-click on originally-empty space
  // still finds a hitNote here. Distinguish that from an intentional double-click-to-delete of a
  // pre-existing note by checking whether this exact note was placed moments ago by this same gesture.
  const isTransientPlacement = hitNote && hitNote.id===BB.justPlacedNoteId
    && (performance.now()-BB.justPlacedAt) < JUST_PLACED_WINDOW_MS;
  if(!hitNote || isTransientPlacement){
    if(isTransientPlacement){
      if(historyDepth()) dropCheckpoint(); // cancel the placement's own checkpoint — net state is unchanged
      track.notes = track.notes.filter(n=>n.id!==hitNote.id);
      BB.selectedNoteIds.delete(hitNote.id);
      BB.justPlacedNoteId = null;
      buildTrackList(); recomputeStepsTotal();
    }
    BB.phantomSelection = BB.phantomSelection ? null : {step:clampPhantomStep(step), row};
    renderNotes();
    if(BB.phantomSelection) scrollSelectionIntoView();
    e.stopPropagation(); e.preventDefault();
    return;
  }
  pushHistory();
  track.notes = track.notes.filter(n=>n.id!==hitNote.id);
  BB.selectedNoteIds.delete(hitNote.id);
  renderNotes(); buildTrackList(); recomputeStepsTotal();
  e.stopPropagation(); e.preventDefault();
});

function onGridMouseDown(e){
  const track = selectedTrack(); if(!track) return;
  BB.editContext = "notes";

  // the mirrored grip on a tile's left edge: drag to trim the start of the note while its right edge
  // (and any slur target) stays put
  if(e.target.classList && e.target.classList.contains("leftHandle")){
    const noteEl = e.target.closest(".note");
    const note = track.notes.find(n=>n.id===Number(noteEl.dataset.id));
    if(note){
      pushHistory();
      drag = {mode:"resizeLeft", noteId:note.id, fixedEnd:note.step+note.dur};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  // the little grip on a tile's right edge: drag sideways to resize, or (only if the note isn't already
  // slurred) up/down to start a new slur — once a slur exists, its target is adjusted via the separate
  // bendStub instead, so this handle stays dedicated to length once that stub appears
  if(e.target.classList && e.target.classList.contains("bendHandle")){
    const noteEl = e.target.closest(".note");
    const note = track.notes.find(n=>n.id===Number(noteEl.dataset.id));
    if(note){
      pushHistory();
      // the slur target maps 1:1 to the row the cursor is over (so it always matches where notes sit
      // elsewhere on the grid), but that mapping only "engages" once the mouse has actually moved some
      // vertical distance — otherwise just touching the grip to resize horizontally would instantly
      // snap an existing slur back to the note's own pitch
      drag = {mode:"bend", noteId:note.id, startClientY:e.clientY, bendEngaged:false, allowBend: note.bendTo==null, lastPreviewPitch:null};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  // the small stub on a slurred note: drag it up/down to retarget the slur pitch, or sideways to
  // change how much of the tile the slide takes up (the note's own length stays the resize handle's job)
  if(e.target.classList && e.target.classList.contains("bendStub")){
    const note = track.notes.find(n=>n.id===Number(e.target.dataset.id));
    if(note){
      pushHistory();
      drag = {mode:"bendAdjust", noteId:note.id, lastPreviewPitch:null};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  // the dot where the slur's slide-line meets the tile: drag it sideways to move where within the
  // note the pitch actually starts sliding, independent of the note's own length or slur target
  if(e.target.classList && e.target.classList.contains("bendStartHandle")){
    const note = track.notes.find(n=>n.id===Number(e.target.dataset.id));
    if(note){
      pushHistory();
      drag = {mode:"bendStartAdjust", noteId:note.id};
      e.preventDefault(); e.stopPropagation();
      return;
    }
  }

  const {step,row,x,y} = xyToStepRow(e.clientX,e.clientY);

  // grab the playhead if the click lands near its current position
  const phX = currentPlayStep()*BB.STEP_W;
  if(Math.abs(x-phX)<=5){
    if(state.playing) stopPlayback(false);
    BB.playheadDrag = {type:"grid"};
    e.preventDefault();
    return;
  }

  if(step<0||step>=BB.STEPS_TOTAL||row<0||row>=TOTAL_ROWS) return;

  if(e.shiftKey || e.altKey){
    // rubber band select — keeps whatever's already selected and adds whatever the band covers
    drag = {mode:"select", x0:x, y0:y, baseline:new Set(BB.selectedNoteIds)};
    const box = document.getElementById("selectionBox");
    box.style.display="block"; box.style.left=x+"px"; box.style.top=y+"px"; box.style.width="0px"; box.style.height="0px";
    e.preventDefault();
    return;
  }

  // is there a note at this cell? Look it up by grid position (not by which DOM element the
  // click happened to land on) so clicking anywhere on/near a tile always selects it — never deletes it.
  const hitNote = track.notes.find(n=> row===midiToRow(n.pitch) && step>=n.step && step<n.step+n.dur);
  if(hitNote){
    if(e.detail>=2){ e.preventDefault(); return; } // double-click: let the dblclick handler delete it
    // a tile winning the selection clears every other kind of selection in the app (regions,
    // automation dots, the phantom cell) and drops focus off whatever control was last clicked
    clearNonNoteSelections();
    // slurred tiles preview the slide itself (base pitch sliding into the target) rather than just
    // the base pitch alone, compressed into the same short preview length
    if(!state.playing) previewNote(track, hitNote.pitch, hitNote.bendTo);
    if(!BB.selectedNoteIds.has(hitNote.id)){
      if(!e.shiftKey) BB.selectedNoteIds.clear();
      BB.selectedNoteIds.add(hitNote.id);
      renderNotes(); scrollSelectionIntoView();
    } else if(e.shiftKey){
      BB.selectedNoteIds.delete(hitNote.id); renderNotes(); scrollSelectionIntoView(); return;
    }
    pushHistory();
    const originNotes = track.notes.filter(n=>BB.selectedNoteIds.has(n.id)).map(n=>({id:n.id, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null}));
    drag = {mode:"move", startStep:step, startMidiRow:row, origin:originNotes, moved:false, lastPreviewPitch:hitNote.pitch};
    e.preventDefault();
    return;
  }

  // empty cell with an existing selection: the first click just clears it, matching how clicking empty
  // space deselects elsewhere — placing a new note is a deliberate second click, not a side effect of
  // dismissing whatever was highlighted.
  // The exception is a selection that placement itself just made: now that placing a tile selects it,
  // letting that selection swallow the next click would turn note entry into two clicks per note.
  if(BB.selectedNoteIds.size && !selectionFromPlacement){
    BB.selectedNoteIds.clear();
    renderNotes();
    e.preventDefault();
    return;
  }

  // empty cell: hold + drag sets a custom note length (start -> end point); a short click places the default length
  pushHistory();
  drag = {mode:"place", row, startStep:step, pitch:rowToMidi(row), downX:e.clientX, downY:e.clientY, dragged:false, noteId:null};
  e.preventDefault();
}

// exactly one preview sounding at a time, the same discipline stopChordPreview enforces for the chord
// palette. This one matters more than it looks: every caller below re-fires a preview on key REPEAT, and
// ArrowLeft/ArrowRight move a tile along the timeline without changing its pitch — so holding either one
// restarts the SAME pitch ~30 times a second while each 0.18s voice is still sounding. Identical
// waveforms started that close together stay in phase and SUM rather than masking one another; eight of
// them measured 3.4x the peak of a single note and clipped straight through the master bus, which is
// what "that note is suddenly deafening" turns out to be. Swapping the voice out instead of piling on
// keeps a preview at the volume of the note it is previewing.
let notePreviewVoices = [];
const PREVIEW_FADE_SEC = 0.008;
function stopNotePreview(){
  if(!notePreviewVoices.length) return;
  const now = actx.currentTime;
  notePreviewVoices.forEach(v=>{
    // a short ramp rather than the instant setValueAtTime(0) that silenceAllVoices and stopChordPreview
    // use: those fire on a pause or a palette click, while this fires on every arrow repeat and every
    // row a drag crosses, so a hard cut mid-waveform would put an audible tick under ordinary editing.
    // Either call can throw on a voice that already finished, and a finished voice is already silent,
    // so there is genuinely nothing to do about a failure.
    try{
      v.env.gain.cancelScheduledValues(now);
      v.env.gain.setValueAtTime(v.env.gain.value, now);
      v.env.gain.linearRampToValueAtTime(0.0001, now+PREVIEW_FADE_SEC);
    }catch(_){}
    try{ v.source.stop(now+PREVIEW_FADE_SEC); }catch(_){}
  });
  notePreviewVoices = [];
}
function previewNote(track, midi, bendTo){
  stopNotePreview();
  playNote(track, {midi, startTime: actx.currentTime+0.01, durSec: 0.18, bendToMidi: bendTo}, liveTarget(track));
  // playNote doesn't hand its voice back, but it appends exactly one entry to activeVoices for every
  // live (non-render) call, so the tail of that array is the voice just created. Holding the record
  // itself is safe across the filter/reassign playNote does to prune finished voices.
  const v = BB.activeVoices[BB.activeVoices.length-1];
  if(v) notePreviewVoices.push(v);
}

window.addEventListener("mousemove", (e)=>{
  if(BB.autoDrag){
    const track = state.tracks.find(t=>t.id===BB.autoDrag.trackId);
    if(track){
      const rect = document.getElementById("advLaneCanvas").getBoundingClientRect();
      const spb = stepsPerBar();
      const curStep = (e.clientX-rect.left)/BB.BAR_PX*spb;
      const curValue = 100-(e.clientY-rect.top)/BB.ADV_LANE_H*100;
      const dStep = curStep-BB.autoDrag.startStep, dValue = curValue-BB.autoDrag.startValue;
      const points = track.automation[BB.autoDrag.param];
      BB.autoDrag.origin.forEach(o=>{
        const p = points.find(x=>x.id===o.id); if(!p) return;
        p.step = Math.max(0, o.step+dStep);
        p.value = Math.max(0, Math.min(100, o.value+dValue));
      });
      renderAdvancedEditor();
    }
    return;
  }
  if(BB.loopDrag){
    const rect = document.getElementById("trackListInner").getBoundingClientRect();
    const stepAt = (e.clientX-rect.left)/BB.BAR_PX*stepsPerBar();
    if(BB.loopDrag.mode==="resizeL"){
      state.loop.start = Math.max(0, Math.min(state.loop.end-1, Math.round(stepAt)));
    } else if(BB.loopDrag.mode==="resizeR"){
      state.loop.end = Math.max(state.loop.start+1, Math.min(BB.STEPS_TOTAL, Math.round(stepAt)));
    } else if(BB.loopDrag.mode==="move"){
      const len = BB.loopDrag.startEnd-BB.loopDrag.startStart;
      const delta = Math.round(stepAt-BB.loopDrag.downStep);
      const newStart = Math.max(0, Math.min(BB.STEPS_TOTAL-len, BB.loopDrag.startStart+delta));
      state.loop.start = newStart; state.loop.end = newStart+len;
    }
    renderLoopUI();
    return;
  }
  if(BB.trackDrag){
    const track = state.tracks.find(t=>t.id===BB.trackDrag.trackId);
    if(track){
      const deltaSteps = Math.round((e.clientX-BB.trackDrag.startX)/BB.BAR_PX*stepsPerBar());
      const minOrigin = BB.trackDrag.origin.length ? Math.min(...trackDrag.origin.map(o=>o.step)) : 0;
      const lowerBound = Math.max(-minOrigin, BB.trackDrag.minDelta);
      const clampedDelta = Math.max(lowerBound, Math.min(BB.trackDrag.maxDelta, deltaSteps));
      BB.trackDrag.origin.forEach(o=>{
        const n = track.notes.find(x=>x.id===o.id); if(!n) return;
        n.step = o.step+clampedDelta;
      });
      if(BB.trackDrag.originRegions && track.regions){
        BB.trackDrag.originRegions.forEach(o=>{
          const r = track.regions.find(x=>x.id===o.id); if(!r) return;
          r.start = Math.max(0, o.start+clampedDelta); r.end = Math.max(r.start+1, o.end+clampedDelta);
        });
      }
      if(track.id===state.selectedTrackId) renderNotes();
      buildTrackList();
    }
    return;
  }
  if(BB.playheadDrag){
    let step;
    if(BB.playheadDrag.type==="grid"){
      const rect = gridInner.getBoundingClientRect();
      step = (e.clientX-rect.left)/BB.STEP_W;
    } else {
      const rect = document.getElementById("trackListInner").getBoundingClientRect();
      step = (e.clientX-rect.left)/BB.BAR_PX*stepsPerBar();
    }
    state.playStartStep = Math.max(0, Math.min(BB.STEPS_TOTAL, step));
    renderPlayheads();
    return;
  }
  if(!drag) return;
  const track = selectedTrack(); if(!track) return;
  const {step,row,x,y} = xyToStepRow(e.clientX,e.clientY);

  if(drag.mode==="select"){
    const box = document.getElementById("selectionBox");
    const left = Math.min(drag.x0,x), top=Math.min(drag.y0,y);
    const w = Math.abs(x-drag.x0), h=Math.abs(y-drag.y0);
    box.style.left=left+"px"; box.style.top=top+"px"; box.style.width=w+"px"; box.style.height=h+"px";
    const s0=Math.floor(left/BB.STEP_W), s1=Math.ceil((left+w)/BB.STEP_W);
    const r0=Math.floor((top-GRID_RULER_H)/ROW_H), r1=Math.ceil((top+h-GRID_RULER_H)/ROW_H);
    BB.selectedNoteIds = new Set(drag.baseline);
    track.notes.forEach(n=>{
      const r = midiToRow(n.pitch);
      if(n.step+n.dur>s0 && n.step<s1 && r>=r0 && r<r1) BB.selectedNoteIds.add(n.id);
    });
    // the band sweeping over its first tile makes notes the selection, so everything else deselects —
    // the helper's own guards keep this from rebuilding anything on the frames after that first one
    if(BB.selectedNoteIds.size) clearNonNoteSelections();
    renderNotes();
  } else if(drag.mode==="move"){
    const dStep = step-drag.startStep, dRow = row-drag.startMidiRow;
    const movingIds = new Set(drag.origin.map(o=>o.id));
    const candidates = drag.origin.map(o=>({
      id:o.id, dur:o.dur,
      newStep: Math.max(0, Math.min(BB.STEPS_TOTAL-o.dur, o.step+dStep)),
      newPitch: Math.max(0, Math.min(127, o.pitch-dRow)),
      newBendTo: o.bendTo!=null ? Math.max(0, Math.min(127, o.bendTo-dRow)) : null
    }));
    const valid = candidates.every(c=>{
      const r = midiToRow(c.newPitch);
      return !track.notes.some(n=> !movingIds.has(n.id) && midiToRow(n.pitch)===r && c.newStep < n.step+n.dur && c.newStep+c.dur > n.step);
    });
    if(valid && (dStep!==0||dRow!==0)){
      drag.moved=true;
      candidates.forEach(c=>{
        const n = track.notes.find(x=>x.id===c.id); if(!n) return;
        n.step=c.newStep; n.pitch=c.newPitch; n.bendTo=c.newBendTo;
      });
      renderNotes();
      if(dRow!==0 && candidates.length){
        const pitchNow = candidates[0].newPitch;
        if(drag.lastPreviewPitch!==pitchNow){
          if(!state.playing) previewNote(track, pitchNow);
          drag.lastPreviewPitch = pitchNow;
        }
      }
    }
    showTooltip(e.clientX, e.clientY, "Δstep "+dStep+"  Δpitch "+(-dRow));
  } else if(drag.mode==="place"){
    const dx = Math.abs(e.clientX-drag.downX), dy = Math.abs(e.clientY-drag.downY);
    if(!drag.dragged && (dx>5||dy>5)) drag.dragged = true;
    if(drag.dragged){
      const endStep = Math.max(drag.startStep, step);
      const desiredDur = endStep - drag.startStep + 1;
      const dur = noteOverlapMaxDur(track, drag.row, drag.startStep, desiredDur, drag.noteId);
      if(drag.noteId==null){
        drag.noteId = BB.nextNoteId++;
        const newNote = {id:drag.noteId, step:drag.startStep, pitch:drag.pitch, dur, bendTo:null};
        track.notes.push(newNote);
        extendRegionsForNote(track, newNote);
        // a placed tile IS the selection, so the length can be retyped or the tile nudged straight
        // away — same for the drag-a-custom-length path as for a plain click (see the mouseup branch)
        selectNotesExclusively([newNote.id], true);
        previewNote(track, drag.pitch);
      } else {
        const n = track.notes.find(nn=>nn.id===drag.noteId);
        if(n) n.dur = dur;
      }
      renderNotes();
      showTooltip(e.clientX, e.clientY, dur+" step"+(dur===1?"":"s"));
    }
  } else if(drag.mode==="bend"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      // horizontal movement resizes the note's length, same as dragging a fresh tile's end point
      const endStep = Math.max(note.step, step);
      const desiredDur = endStep - note.step + 1;
      const newDur = noteOverlapMaxDur(track, midiToRow(note.pitch), note.step, desiredDur, note.id);
      if(newDur!==note.dur){
        note.dur = newDur;
        extendRegionsForNote(track, note);
      }

      // vertical movement starts a new slur/tie target — only while the note has no slur yet, though:
      // once a bendStub exists, this handle stays dedicated to length and the stub handles retargeting.
      // the cursor's row maps straight to a pitch, 1:1 with wherever notes actually sit on the grid, but
      // that mapping only "engages" once the mouse has moved a few real pixels vertically, so a
      // horizontal-only resize can't accidentally start a slur
      if(drag.allowBend){
        if(!drag.bendEngaged && Math.abs(e.clientY-drag.startClientY)>5) drag.bendEngaged = true;
        if(drag.bendEngaged){
          const clampedRow = Math.max(0, Math.min(TOTAL_ROWS-1, row));
          const newPitch = rowToMidi(clampedRow);
          if(newPitch !== (note.bendTo??note.pitch)){
            note.bendTo = newPitch===note.pitch ? null : newPitch;
          }
          // announce whatever pitch is currently under the cursor while the slur is being dragged out,
          // same as retargeting an existing slur via the bendStub does
          if(drag.lastPreviewPitch!==newPitch){
            if(!state.playing) previewNote(track, newPitch);
            drag.lastPreviewPitch = newPitch;
          }
        }
      }

      renderNotes();
      const lenText = note.dur+" step"+(note.dur===1?"":"s");
      showTooltip(e.clientX, e.clientY, note.bendTo!=null ? lenText+" · slur to "+midiToName(note.bendTo) : lenText);
    }
  } else if(drag.mode==="bendAdjust"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      let changed = false;
      const clampedRow = Math.max(0, Math.min(TOTAL_ROWS-1, row));
      const newPitch = rowToMidi(clampedRow);
      if(newPitch !== (note.bendTo??note.pitch)){
        note.bendTo = newPitch===note.pitch ? null : newPitch;
        changed = true;
      }
      // sideways movement independently adjusts how much of the tile's tail is held at the target pitch
      // (vs. still sliding), by moving where the stub's left edge — and thus the slide's end point — sits
      const minEnd = clampedBendStartStep(note)+0.15, maxEnd = note.dur;
      const rawEnd = (x-note.step*BB.STEP_W)/BB.STEP_W;
      const newBendEnd = Math.round(Math.max(minEnd, Math.min(maxEnd, rawEnd))*4)/4;
      if(newBendEnd !== (note.bendEndStep==null?note.dur:note.bendEndStep)){
        note.bendEndStep = newBendEnd;
        changed = true;
      }
      if(changed) renderNotes();
      // announce whatever pitch the stub is currently hovering over, same as dragging a note
      // vertically previews its new pitch — only re-fires when the hovered row actually changes
      if(drag.lastPreviewPitch!==newPitch){
        if(!state.playing) previewNote(track, newPitch);
        drag.lastPreviewPitch = newPitch;
      }
      showTooltip(e.clientX, e.clientY, note.bendTo!=null ? "slur to "+midiToName(note.bendTo) : "slur removed");
    }
  } else if(drag.mode==="resizeLeft"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      const fixedEnd = drag.fixedEnd;
      const minStep = noteOverlapMinStep(track, midiToRow(note.pitch), fixedEnd, note.id);
      const newStep = Math.max(minStep, Math.min(fixedEnd-1, step));
      if(newStep!==note.step){
        note.step = newStep;
        note.dur = fixedEnd-newStep;
        extendRegionsForNote(track, note);
        renderNotes();
      }
      showTooltip(e.clientX, e.clientY, note.dur+" step"+(note.dur===1?"":"s"));
    }
  } else if(drag.mode==="bendStartAdjust"){
    const note = track.notes.find(n=>n.id===drag.noteId);
    if(note){
      const max = Math.max(0, note.dur-0.15);
      const raw = (x - note.step*BB.STEP_W)/BB.STEP_W;
      const newBendStart = Math.round(Math.max(0, Math.min(max, raw))*4)/4; // snap to quarter-steps for a steady drag feel
      if(newBendStart!==note.bendStartStep){
        note.bendStartStep = newBendStart;
        renderNotes();
      }
      showTooltip(e.clientX, e.clientY, "slur begins at step "+(note.step+newBendStart));
    }
  }
});
window.addEventListener("mouseup", ()=>{
  endHistoryGesture();
  if(BB.autoDrag){ BB.autoDrag=null; return; }
  if(BB.loopDrag){ BB.loopDrag=null; return; }
  if(BB.trackDrag){ BB.trackDrag=null; document.body.style.cursor=""; recomputeStepsTotal(); return; }
  if(BB.playheadDrag){
    if(BB.playheadDrag.type==="trackList") BB.suppressTrackListClick = true;
    BB.playheadDrag=null;
    return;
  }
  if(drag){
    if(drag.mode==="select"){ document.getElementById("selectionBox").style.display="none"; scrollSelectionIntoView(); }
    if(drag.mode==="move" && drag.moved){ buildTrackList(); recomputeStepsTotal(); }
    if(drag.mode==="place"){
      const track = selectedTrack();
      if(track){
        if(!drag.dragged){
          const dur = noteOverlapMaxDur(track, drag.row, drag.startStep, state.noteLenSteps, null);
          const newNote = {id: BB.nextNoteId++, step:drag.startStep, pitch:drag.pitch, dur, bendTo:null};
          track.notes.push(newNote);
          extendRegionsForNote(track, newNote);
          BB.justPlacedNoteId = newNote.id; BB.justPlacedAt = performance.now();
          // the note the user just placed becomes the selection (and clears every other one), so its
          // type can be changed from the Note Length dropdown without hunting for it again
          selectNotesExclusively([newNote.id], true);
          if(!state.playing) previewNote(track, drag.pitch);
          renderNotes();
        }
        buildTrackList();
        recomputeStepsTotal();
      }
    }
    if(drag.mode==="bend" || drag.mode==="bendAdjust" || drag.mode==="resizeLeft"){ buildTrackList(); recomputeStepsTotal(); }
  }
  drag=null; hideTooltip();
});

/* ---------- no sticky focus on ANY button, dropdown or slider ----------
   A control that keeps focus after being clicked is wrong twice over: it LOOKS selected (the focus ring
   is indistinguishable from persistent on/off state), and it BEHAVES selected — stray Delete/Backspace/
   arrow presses get eaten by the control instead of reaching the note editor. So every mouse
   interaction hands focus back as soon as it finishes, everywhere in the app.
   Text-entry fields are deliberately excluded: the project title's swapped-in input, instrument-row
   renames, #bpmInput and the modal fields are things the user is actively typing into, and blurring
   those mid-edit would commit/close them under the cursor. */
document.addEventListener("mouseup",(e)=>{
  const el = e.target && e.target.closest ? e.target.closest("button, input[type=range]") : null;
  if(el) el.blur();
});
// <select> can't join the mouseup rule: blurring while its native popup is open dismisses the popup
// before a value can be picked. It hands focus back on the two signals that mean "the popup is done"
// instead — the value being committed (change), and the next mousedown anywhere else, which is the
// only signal a popup dismissed WITHOUT a change ever gives us. That second case matters because the
// piano roll calls preventDefault() on mousedown, which suppresses the browser's own focus change.
let selectTouchedByMouse = false;
document.addEventListener("mousedown",(e)=>{
  const active = document.activeElement;
  if(active && active.tagName==="SELECT" && active!==e.target) active.blur();
  selectTouchedByMouse = !!(e.target && e.target.tagName==="SELECT");
}, true);
// a keyboard user arrowing through a focused select must keep it — Firefox fires "change" on every
// arrow press, so the blur-on-change below only applies to a select the MOUSE opened
document.addEventListener("keydown",()=>{ selectTouchedByMouse = false; }, true);
document.addEventListener("change",(e)=>{
  if(e.target.tagName==="SELECT" && selectTouchedByMouse){ selectTouchedByMouse = false; e.target.blur(); }
});
// drops keyboard focus from a clicked button/dropdown/slider on demand (never from a text field being
// edited) — used by the selection paths below, where the same "the control isn't what's selected
// anymore" rule has to fire without waiting for the next mouseup
function blurFocusedControl(){
  const el = document.activeElement;
  if(!el || el===document.body) return;
  const tag = el.tagName;
  if(tag==="BUTTON" || tag==="SELECT" || (tag==="INPUT" && el.type==="range")) el.blur();
}

function showTooltip(x,y,text){
  const tip = document.getElementById("dragTooltip");
  tip.style.display="block"; tip.style.left=(x+14)+"px"; tip.style.top=(y+14)+"px"; tip.textContent=text;
}
function hideTooltip(){ document.getElementById("dragTooltip").style.display="none"; }

document.addEventListener("keydown", (e)=>{
  const activeEl = document.activeElement;
  const tag = activeEl.tagName;
  const isTextEntry = tag==="SELECT" || tag==="TEXTAREA" || (tag==="INPUT" && activeEl.type!=="range");
  if(isTextEntry) return;

  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="z"){
    e.preventDefault();
    if(e.shiftKey) redo(); else undo();
    return;
  }
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="y"){
    e.preventDefault(); redo(); return;
  }

  if(BB.editContext==="track" && (e.ctrlKey||e.metaKey) && (e.key.toLowerCase()==="c"||e.key.toLowerCase()==="v"||e.key.toLowerCase()==="x")){
    const track = selectedTrack();
    const k = e.key.toLowerCase();
    if(k==="c" || k==="x"){
      if(!track) return;
      state.trackClipboard = {
        name:track.name, color:track.color, instrument:Object.assign({},track.instrument),
        volume:track.volume, notes: track.notes.map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null,bendStartStep:n.bendStartStep??0,bendEndStep:n.bendEndStep??null})),
        regions: track.regions ? track.regions.map(r=>({start:r.start,end:r.end})) : null
      };
      if(k==="x"){
        pushHistory();
        state.tracks = state.tracks.filter(t=>t.id!==track.id);
        state.selectedTrackId = state.tracks.length? state.tracks[0].id : null;
        renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); buildTrackList();
        toast("Cut track \""+track.name+"\"");
      } else {
        toast("Copied track \""+track.name+"\"");
      }
    } else {
      if(!state.trackClipboard) return;
      if(pasteOnCooldown()){ e.preventDefault(); return; }
      pushHistory();
      const c = state.trackClipboard;
      const newTrack = makeTrack(c.name+" copy", state.tracks.length);
      newTrack.instrument = Object.assign({}, c.instrument);
      newTrack.volume = c.volume;
      newTrack.notes = c.notes.map(n=>({...n, id: BB.nextNoteId++}));
      newTrack.regions = c.regions ? c.regions.map(r=>({id: BB.nextNoteId++, start:r.start, end:r.end})) : null;
      buildChain(newTrack);
      state.tracks.push(newTrack);
      selectTrack(newTrack.id);
      recomputeStepsTotal();
      toast("Pasted track \""+newTrack.name+"\"");
    }
    e.preventDefault();
    return;
  }

  // automation dots delete the same way notes/tracks do — checked independently of the note-selection
  // track below, since the advanced editor's target track need not be the currently selected one
  if((e.key==="Delete"||e.key==="Backspace") && state.advancedTrackId!=null && selectedAutoPointIds.size){
    const advT = advTrack();
    if(advT){
      pushHistory();
      const points = advT.automation[state.advancedParam];
      advT.automation[state.advancedParam] = points.filter(p=>!selectedAutoPointIds.has(p.id));
      selectedAutoPointIds.clear();
      renderAdvancedEditor();
      e.preventDefault();
      return;
    }
  }

  const track = selectedTrack(); if(!track) return;

  if(BB.editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="c"){
    state.clipboard = track.notes.filter(n=>BB.selectedNoteIds.has(n.id)).map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null,bendStartStep:n.bendStartStep??0,bendEndStep:n.bendEndStep??null}));
    if(state.clipboard.length) toast("Copied "+state.clipboard.length+" note(s)");
    e.preventDefault();
  } else if(BB.editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="x"){
    if(!BB.selectedNoteIds.size) return;
    pushHistory();
    state.clipboard = track.notes.filter(n=>BB.selectedNoteIds.has(n.id)).map(n=>({step:n.step,pitch:n.pitch,dur:n.dur,bendTo:n.bendTo??null,bendStartStep:n.bendStartStep??0,bendEndStep:n.bendEndStep??null}));
    track.notes = track.notes.filter(n=>!BB.selectedNoteIds.has(n.id));
    BB.selectedNoteIds.clear();
    renderNotes(); buildTrackList();
    toast("Cut "+state.clipboard.length+" note(s)");
    e.preventDefault();
  } else if(BB.editContext==="notes" && (e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="v"){
    if(!state.clipboard.length) return;
    if(pasteOnCooldown()){ e.preventDefault(); return; }
    pushHistory();
    const minStep = Math.min(...state.clipboard.map(n=>n.step));
    // if the current selection is still on this track (e.g. right after a copy, or after a prior
    // paste made the pasted notes the selection), anchor the new paste immediately to its right so
    // repeated Ctrl+V walks a copy rightward instead of always landing back at the playhead
    const selectedOnTrack = track.notes.filter(n=>BB.selectedNoteIds.has(n.id));
    const pasteAt = selectedOnTrack.length
      ? Math.max(...selectedOnTrack.map(n=>n.step+n.dur))
      : Math.round(currentPlayStep());
    // tiles may not exist inside one another: the group is offered to the track as a unit and climbs
    // until it clears, or reports that it cannot (see findClearTransposition)
    const landing = state.clipboard.map(n=>({step: pasteAt+(n.step-minStep), pitch:n.pitch, dur:n.dur}));
    const semitonesUp = findClearTransposition(track, landing);
    const offset = semitonesUp ?? 0;
    const newIds = [];
    state.clipboard.forEach(n=>{
      const id = BB.nextNoteId++;
      // the slur target travels with the note it belongs to — leaving it behind would point the slide
      // at a pitch the transposed tile no longer has any relationship to
      const newNote = {id, step: pasteAt+(n.step-minStep), pitch:n.pitch+offset, dur:n.dur,
        bendTo: n.bendTo==null ? null : clampToGrid(n.bendTo+offset),
        bendStartStep:n.bendStartStep??0, bendEndStep:n.bendEndStep??null};
      track.notes.push(newNote);
      extendRegionsForNote(track, newNote);
      newIds.push(id);
    });
    // the pasted notes are the new selection, and — like any other way notes become selected — that
    // wins over any region/automation-dot/phantom selection that was still showing
    selectNotesExclusively(newIds);
    // nowhere clear anywhere up the grid: the paste happens anyway, on top of what was there, but only
    // on loan — it survives being deselected exactly where it no longer overlaps
    if(semitonesUp==null) beginPendingPaste(newIds, track.id);
    renderNotes(); buildTrackList(); recomputeStepsTotal();
    toast(semitonesUp==null
      ? "Pasted "+newIds.length+" note(s) over existing notes — move them or they'll be discarded"
      : "Pasted "+newIds.length+" note(s) at step "+pasteAt
        + (offset ? " (moved up "+offset+" semitone"+(offset===1?"":"s")+" to avoid overlap)" : ""));
    e.preventDefault();
  } else if(e.key==="Delete" || e.key==="Backspace"){
    if(BB.selectedNoteIds.size){
      pushHistory();
      track.notes = track.notes.filter(n=>!BB.selectedNoteIds.has(n.id));
      BB.selectedNoteIds.clear(); renderNotes(); buildTrackList();
      e.preventDefault();
    } else if(BB.editContext==="track" && state.selectedTrackId!=null){
      deleteSelectedTrack();
      e.preventDefault();
    }
  } else if(e.key==="ArrowUp" && BB.selectedNoteIds.size){
    pushHistory();
    let previewPitch = null;
    track.notes.forEach(n=>{
      if(!BB.selectedNoteIds.has(n.id)) return;
      const p = Math.min(127,n.pitch+1), r = midiToRow(p);
      if(!track.notes.some(o=>!BB.selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && n.step<o.step+o.dur && n.step+n.dur>o.step)){
        if(n.bendTo!=null) n.bendTo = Math.min(127, n.bendTo+1);
        n.pitch=p;
        if(previewPitch==null) previewPitch = p;
      }
    });
    if(previewPitch!=null && !state.playing) previewNote(track, previewPitch);
    renderNotes(); scrollSelectionIntoView(); e.preventDefault();
  } else if(e.key==="ArrowDown" && BB.selectedNoteIds.size){
    pushHistory();
    let previewPitch = null;
    track.notes.forEach(n=>{
      if(!BB.selectedNoteIds.has(n.id)) return;
      const p = Math.max(0,n.pitch-1), r = midiToRow(p);
      if(!track.notes.some(o=>!BB.selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && n.step<o.step+o.dur && n.step+n.dur>o.step)){
        if(n.bendTo!=null) n.bendTo = Math.max(0, n.bendTo-1);
        n.pitch=p;
        if(previewPitch==null) previewPitch = p;
      }
    });
    if(previewPitch!=null && !state.playing) previewNote(track, previewPitch);
    renderNotes(); scrollSelectionIntoView(); e.preventDefault();
  } else if(e.key==="ArrowLeft" && BB.selectedNoteIds.size){
    pushHistory();
    let previewPitch = null;
    track.notes.forEach(n=>{
      if(!BB.selectedNoteIds.has(n.id)) return;
      const s = Math.max(0,n.step-1), r = midiToRow(n.pitch);
      if(!track.notes.some(o=>!BB.selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && s<o.step+o.dur && s+n.dur>o.step)){
        n.step=s;
        if(previewPitch==null) previewPitch = n.pitch;
      }
    });
    if(previewPitch!=null && !state.playing) previewNote(track, previewPitch);
    renderNotes(); buildTrackList(); scrollSelectionIntoView(); e.preventDefault();
  } else if(e.key==="ArrowRight" && BB.selectedNoteIds.size){
    pushHistory();
    let previewPitch = null;
    track.notes.forEach(n=>{
      if(!BB.selectedNoteIds.has(n.id)) return;
      const s = n.step+1, r = midiToRow(n.pitch);
      if(!track.notes.some(o=>!BB.selectedNoteIds.has(o.id) && midiToRow(o.pitch)===r && s<o.step+o.dur && s+n.dur>o.step)){
        n.step=s;
        if(previewPitch==null) previewPitch = n.pitch;
      }
    });
    if(previewPitch!=null && !state.playing) previewNote(track, previewPitch);
    renderNotes(); buildTrackList(); recomputeStepsTotal(); scrollSelectionIntoView(); e.preventDefault();
  } else if(BB.phantomSelection && !BB.selectedNoteIds.size && (e.key==="ArrowUp"||e.key==="ArrowDown"||e.key==="ArrowLeft"||e.key==="ArrowRight")){
    // phantom (empty-cell) navigation: moves the highlighted cell only, never touches track.notes —
    // no pushHistory(), since nothing about the project actually changes
    if(e.key==="ArrowUp") BB.phantomSelection.row = Math.max(0, BB.phantomSelection.row-1);
    else if(e.key==="ArrowDown") BB.phantomSelection.row = Math.min(TOTAL_ROWS-1, BB.phantomSelection.row+1);
    // still one step per press — only the rendered span follows the Note Length
    else if(e.key==="ArrowLeft") BB.phantomSelection.step = clampPhantomStep(BB.phantomSelection.step-1);
    else if(e.key==="ArrowRight") BB.phantomSelection.step = clampPhantomStep(BB.phantomSelection.step+1);
    renderNotes();
    scrollSelectionIntoView();
    e.preventDefault();
  } else if(e.key==="Escape" && BB.selectedNoteIds.size){
    // the keyboard's version of clicking empty grid to drop the selection — and the one way out of a
    // provisional paste that does not involve aiming at something else first
    BB.selectedNoteIds.clear();
    renderNotes(); e.preventDefault();
  } else if(e.code==="Space"){
    e.preventDefault();
    togglePlayPause();
  }
});

// click empty grid area (no shift) to move playhead
gridScroll.addEventListener("dblclick",(e)=>{
  if(e.target.id==="gridCanvas"){
    const {step} = xyToStepRow(e.clientX,e.clientY);
    state.playStartStep = Math.max(0,step); renderPlayheads();
  }
});
gridCanvas.addEventListener("contextmenu",(e)=>{
  e.preventDefault();
  const {step} = xyToStepRow(e.clientX,e.clientY);
  state.playStartStep = Math.max(0,step); renderPlayheads();
});

// the bigger square grip on top of the grid playhead — larger, easier target to grab and drag
document.getElementById("playheadGrip").addEventListener("mousedown",(e)=>{
  if(state.playing) stopPlayback(false);
  BB.playheadDrag = {type:"grid"};
  e.preventDefault(); e.stopPropagation();
});

// secondary timeline pinned atop the note grid itself — click to jump the playhead there directly, or
// drag same as the flag/grip, without needing to first scroll all the way up to the arrange view
document.getElementById("gridRuler").addEventListener("mousedown",(e)=>{
  if(state.playing) stopPlayback(false);
  const rect = gridInner.getBoundingClientRect();
  state.playStartStep = Math.max(0, Math.min(BB.STEPS_TOTAL, (e.clientX-rect.left)/BB.STEP_W));
  BB.playheadDrag = {type:"grid"};
  renderPlayheads();
  e.preventDefault(); e.stopPropagation();
});

/* exported to the shared namespace */
Object.assign(BB, { noteOverlapMaxDur, resolvePendingPaste, selectNotesExclusively });
})();

/* Bit Beats — header and sub-header controls: key/mode/BPM, project title, transport buttons
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { GRID_RULER_H, NOTE_NAMES, OCT_MAX, OCT_MIN, ROW_H, state, gridScroll } = BB;
const selectedTrack = (...a)=> BB.selectedTrack(...a), dropCheckpoint = (...a)=> BB.dropCheckpoint(...a),
      pushHistory = (...a)=> BB.pushHistory(...a), buildPianoLabels = (...a)=> BB.buildPianoLabels(...a),
      drawGridLines = (...a)=> BB.drawGridLines(...a), drawGridRuler = (...a)=> BB.drawGridRuler(...a),
      extendRegionsForNote = (...a)=> BB.extendRegionsForNote(...a), midiToRow = (...a)=> BB.midiToRow(...a),
      recomputeStepsTotal = (...a)=> BB.recomputeStepsTotal(...a), renderNotes = (...a)=> BB.renderNotes(...a),
      syncPianoScroll = (...a)=> BB.syncPianoScroll(...a),
      transposeProjectToMode = (...a)=> BB.transposeProjectToMode(...a),
      togglePlayPause = (...a)=> BB.togglePlayPause(...a), buildTrackList = (...a)=> BB.buildTrackList(...a),
      clampPhantomStep = (...a)=> BB.clampPhantomStep(...a),
      scrollSelectionIntoView = (...a)=> BB.scrollSelectionIntoView(...a), toast = (...a)=> BB.toast(...a);
/* ======================================================================
   UI BUILD: HEADER SELECTS
   ====================================================================== */
const keySel = document.getElementById("keySel");
NOTE_NAMES.forEach(n=>{ const o=document.createElement("option"); o.value=n; o.textContent=n; keySel.appendChild(o); });
const octaveSel = document.getElementById("octaveSel");
for(let o=OCT_MIN;o<=OCT_MAX;o++){ const opt=document.createElement("option"); opt.value=o; opt.textContent="Octave "+o+(o===4?" (default)":""); octaveSel.appendChild(opt); }
octaveSel.value=4;

/* ======================================================================
   HEADER CONTROL EVENTS
   ====================================================================== */
document.getElementById("bpmInput").addEventListener("change",(e)=>{ state.bpm = Math.max(30,Math.min(300,Number(e.target.value)||120)); });
document.getElementById("timeSigSel").addEventListener("change",(e)=>{
  const [a,b] = e.target.value.split("/").map(Number); state.timeSig=[a,b]; drawGridLines(); drawGridRuler(); buildTrackList();
});
/* ---------- retype the selected notes, keeping their SPACING ----------
   Changing the note type of a selection re-types every selected note to `newDur` and then re-lays the
   run out so the GAPS between consecutive notes are exactly what they were — the gap is the invariant,
   not the absolute positions. Turning a run of quarters into sixteenths therefore compacts it (and
   turning them back stretches it out again) while the rhythm's proportions survive intact.
   Pitch is deliberately ignored: the selection is treated as one time-ordered run even when it walks up
   a scale across rows, which is exactly the case this was asked for. */
function retypeSelectedNotes(track, newDur){
  const sel = track.notes.filter(n=>BB.selectedNoteIds.has(n.id)).sort((a,b)=>a.step-b.step);
  if(!sel.length) return;
  pushHistory();
  // notes that START on the same step are a chord: they are laid out as ONE group so they keep sharing
  // a step instead of being strung out into an arpeggio by the re-spacing
  const groups = [];
  sel.forEach(n=>{
    const last = groups[groups.length-1];
    if(last && last.step===n.step) last.notes.push(n);
    else groups.push({step:n.step, notes:[n]});
  });
  // gap[i] = empty space between group i's end and group i+1's start, measured with the ORIGINAL
  // durations (a group's end is its longest note's end). Notes that overlapped would give a negative
  // gap; those are clamped to 0 rather than preserved, so a retype can never deepen an overlap into a
  // pile of stacked tiles — back-to-back (gap 0) is the tightest result the re-spacing will produce.
  const gaps = [];
  for(let i=0;i<groups.length-1;i++){
    const end = Math.max.apply(null, groups[i].notes.map(n=>n.step+n.dur));
    gaps.push(Math.max(0, groups[i+1].step - end));
  }
  // the first group stays anchored on its existing step; every later group starts one newDur plus its
  // own original gap further along. Nothing may end up negative or past the end of the grid — the span
  // can grow, which is what the recomputeStepsTotal() below is for.
  let cursor = Math.max(0, Math.min(groups[0].step, BB.STEPS_TOTAL-newDur));
  groups.forEach((g,i)=>{
    g.notes.forEach(n=>{
      n.step = cursor;
      n.dur = newDur;
      // a slur's start/end offsets are measured in steps from the note's own left edge, so shortening
      // the tile has to pull them back in or the slide would be drawn hanging off the end of it
      if(n.bendEndStep!=null) n.bendEndStep = Math.min(n.bendEndStep, newDur);
      if(n.bendStartStep) n.bendStartStep = Math.min(n.bendStartStep, Math.max(0, newDur-0.15));
      extendRegionsForNote(track, n);
    });
    if(i<groups.length-1) cursor = Math.max(0, Math.min(BB.STEPS_TOTAL-newDur, cursor + newDur + gaps[i]));
  });
  // unselected notes are deliberately NOT consulted for collisions here: clamping a length or a step
  // against a neighbouring tile would silently break the one thing this operation promises to keep
  renderNotes(); buildTrackList(); recomputeStepsTotal();
}

document.getElementById("noteLenSel").addEventListener("change",(e)=>{
  state.noteLenSteps = Number(e.target.value);
  // with notes selected the dropdown acts as a property editor on THEM — it re-types the selection and
  // re-spaces it (below) instead of only deciding what the next placed note will look like
  const track = selectedTrack();
  if(track && BB.selectedNoteIds.size){ retypeSelectedNotes(track, state.noteLenSteps); return; }
  // the ghost cell spans the note length, so a live change resizes it (and may push its right edge
  // past the grid end or out of view) — re-clamp, redraw and re-check scroll
  if(BB.phantomSelection){
    BB.phantomSelection.step = clampPhantomStep(BB.phantomSelection.step);
    renderNotes();
    scrollSelectionIntoView();
  }
});
document.getElementById("keySel").addEventListener("change",(e)=>{ state.key=e.target.value; buildPianoLabels(); drawGridLines(); });
document.getElementById("modeSel").addEventListener("change",(e)=>{
  const prevMode = state.mode;      // read BEFORE state.mode is overwritten below — the sweep and the
  const nextMode = e.target.value;  // toast both name the switch by the mode it came from
  // the two trivial no-ops (re-picking the mode that is already set, or a project with nothing in it)
  // short-circuit ahead of pushHistory(), so they cannot clear the redo stack either
  const anyNotes = state.tracks.some(t=>t.notes.length>0);
  let moved = 0;
  if(prevMode!==nextMode && anyNotes){
    // one checkpoint for the WHOLE sweep, taken before anything moves, so a single Ctrl+Z puts every
    // note back at once rather than unwinding the transposition note by note
    pushHistory();
    moved = transposeProjectToMode(prevMode, nextMode);
    // same idiom as #splitBtn: the mapping can legitimately move nothing (switching to Chromatic, or a
    // part that only uses degrees the two modes agree on), and a checkpoint identical to the state it
    // was taken from is just clutter on the undo stack
    if(!moved) dropCheckpoint();
  }
  state.mode=nextMode;
  buildPianoLabels(); drawGridLines();
  // only redraw the tiles when pitches actually moved; the track list shows the same notes in miniature
  if(moved){
    renderNotes(); buildTrackList();
    toast("Transposed "+moved+" note"+(moved===1?"":"s")+" from "+prevMode+" to "+nextMode);
  }
});
document.getElementById("octaveSel").addEventListener("change",(e)=>{
  state.octaveFocus = Number(e.target.value);
  const midi=(state.octaveFocus+1)*12;
  gridScroll.scrollTop = midiToRow(midi)*ROW_H+GRID_RULER_H - gridScroll.clientHeight/2;
  syncPianoScroll();
});

/* ---------- project title (sub-header): plain text, editable on double-click ----------
   Mirrors how instrument names behave in the instrument list: no border while displaying, a bordered
   input while editing, committed on Enter/blur. state.projectTitle is what serializeProject() writes
   and what the Save dialog prefills its own (still editable) title field from. */
function renderProjectTitle(){
  const span = document.getElementById("projectTitle");
  if(span) span.textContent = state.projectTitle || "Bit Beats Project";
  syncSubHeaderLayout();
}

/* ---------- sub-header horizontal alignment ----------
   The sub-header's first control (the BPM field) is meant to line up under #playBtn in the header row,
   with a fixed clear run of space after the project title. Those two wants fight each other as soon as
   the title gets long, so the resting x is:

       bpmX = clamp(titleRight + SUBHEADER_TITLE_GAP_PX, playBtnX, INSTRUMENT_LIST_DEFAULT_W)

   i.e. the title's required gap pushes the whole group right, never left of #playBtn, and never past
   the instrument-list divider; past that the title truncates with its own ellipsis instead.
   The clamp deliberately uses the CONSTANT 230, not #instrumentListCol's live width: dragging
   #vResizerInstrumentList must not twitch the sub-header buttons, so the two are only ever visually
   related at the column's default size.

   On the gap's SIZE: "BPM sits under #playBtn by default" and "the title always keeps a fixed gap"
   can only both be true if that gap is no wider than the room the default title actually leaves —
   "Bit Beats Project" ends ~112px into the content box (~119 of text, less the ~7px the wrap is pulled
   back by so the title's glyphs line up under #logo's — see textInset below) and #playBtn starts ~127px
   in, so anything above ~15 pushes the group off the play button before the user has typed a thing. 8
   satisfies both rules at rest with a little slack; raise it past that slack and the default title
   starts shoving the group right (the layout still behaves, the alignment just stops being at rest). */
const SUBHEADER_TITLE_GAP_PX = 8;         // clear space demanded between #projectTitle's right edge and the BPM field
const INSTRUMENT_LIST_DEFAULT_W = 230;    // must match #instrumentListCol's default width in style.css
function syncSubHeaderLayout(){
  const sub = document.getElementById("subHeader");
  const wrap = document.getElementById("projectTitleWrap");
  const title = document.getElementById("projectTitle");
  const play = document.getElementById("playBtn");
  const group = sub && sub.querySelector(".hgroup");
  // while the title is being renamed the span is swapped out for an <input> (beginProjectTitleEdit),
  // which sizes itself — leave the layout exactly as it was until the edit commits
  if(!sub || !wrap || !title || !play || !group) return;

  const subCS = getComputedStyle(sub);
  // #subHeader / #header both carry side padding, so the viewport x of the sub-header's CONTENT box is
  // what the title and the flex gaps are actually measured from
  const contentLeft = sub.getBoundingClientRect().left + (parseFloat(subCS.paddingLeft)||0);
  const flexGap = parseFloat(subCS.columnGap) || 0;
  const groupPadLeft = parseFloat(getComputedStyle(group).paddingLeft) || 0;

  // #logo has no padding of its own, so its TEXT starts exactly at the header's content-box left. The
  // title's does not: its own left padding + border (there to give the hover outline and the swapped-in
  // edit <input> breathing room) push the glyphs inboard, and the eye reads that as the title being
  // skewed right of the logo. So the whole wrap is pulled back by exactly that inset — read from the
  // computed style, never hardcoded, so restyling the title's padding cannot silently break the
  // alignment. Everything below then measures from titleLeft, the wrap's real (shifted) origin, instead
  // of contentLeft: the BPM group is placed off the title's right edge, and that edge moved too.
  const titleCS = getComputedStyle(title);
  const textInset = (parseFloat(titleCS.paddingLeft)||0) + (parseFloat(titleCS.borderLeftWidth)||0);
  wrap.style.marginLeft = (-textInset)+"px";
  const titleLeft = contentLeft - textInset;

  // Natural (uncapped) width the title box wants. Measured by briefly dropping BOTH caps this function
  // assigned last pass and reading the browser's own layout, rather than by running the text through
  // measureTextPx: the canvas fallback disagrees with real text layout by ~10px on this font stack
  // (-apple-system does not resolve inside a canvas font string), and an over-estimate here is not
  // harmless — it reserves room the title never uses, which at a small gap is enough to ellipsise a
  // title that actually fits. Costs one forced reflow, on title edits and window resizes only.
  const prevMax = title.style.maxWidth, prevWrapW = wrap.style.width, prevMargin = wrap.style.marginRight;
  title.style.maxWidth = "none"; wrap.style.width = "auto"; wrap.style.marginRight = "0px";
  const naturalW = title.getBoundingClientRect().width;
  title.style.maxWidth = prevMax; wrap.style.width = prevWrapW; wrap.style.marginRight = prevMargin;

  // Space that exists between the title's right edge and the BPM field no matter what anyone asks for:
  // the wrap's own padding, then the sub-header's flex gap, then the group's left padding. It is NOT
  // subtracted from the title's room (that is what was clipping it) — it is cancelled out by the
  // margin below, so SUBHEADER_TITLE_GAP_PX means the rendered clear space and nothing else.
  const wrapCS = getComputedStyle(wrap);
  const structuralGap = (parseFloat(wrapCS.paddingLeft)||0) + (parseFloat(wrapCS.paddingRight)||0)
                      + flexGap + groupPadLeft;
  const wrapPadX = (parseFloat(wrapCS.paddingLeft)||0) + (parseFloat(wrapCS.paddingRight)||0);

  // The title grows freely until the clamp: past it the title is what gives way, not the group's x.
  const defaultX = play.getBoundingClientRect().left;
  const maxTitleW = Math.max(40, INSTRUMENT_LIST_DEFAULT_W - titleLeft - SUBHEADER_TITLE_GAP_PX);
  const titleW = Math.min(naturalW, maxTitleW);
  const bpmX = Math.max(defaultX, titleLeft + titleW + SUBHEADER_TITLE_GAP_PX);

  // the spare pixel is handed out only while the title already fits, where it cannot move the rendered
  // right edge; once the cap is doing real truncation the room is exact
  title.style.maxWidth = (naturalW <= titleW ? titleW+1 : titleW) + "px";
  wrap.style.width = (titleW + wrapPadX) + "px";
  // ...and the group is placed by margin rather than by inflating the wrap, so the title always gets its
  // full titleW of room. The margin goes NEGATIVE whenever the requested gap is tighter than the
  // structural one (which is what lets an 8px gap exist at all beside a 14px flex gap), and positive to
  // push the group out to #playBtn's x when a short title leaves slack.
  wrap.style.marginRight = (bpmX - titleLeft - titleW - structuralGap) + "px";
}
function beginProjectTitleEdit(){
  const wrap = document.getElementById("projectTitleWrap");
  const span = document.getElementById("projectTitle");
  if(!wrap || !span) return;
  const input = document.createElement("input");
  input.type = "text"; input.maxLength = 80; input.id = "projectTitleInput";
  input.value = state.projectTitle || "";
  const commit = ()=>{
    if(!input.isConnected) return;
    state.projectTitle = input.value.trim() || "Bit Beats Project";
    input.replaceWith(span);
    renderProjectTitle();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown",(e)=>{
    if(e.key==="Enter"){ commit(); e.preventDefault(); }
    else if(e.key==="Escape"){ input.value = state.projectTitle || ""; commit(); e.preventDefault(); }
    e.stopPropagation();
  });
  span.replaceWith(input);
  input.focus(); input.select();
}
document.getElementById("projectTitleWrap").addEventListener("click",(e)=>{
  if(e.detail>=2 && e.target.id==="projectTitle") beginProjectTitleEdit();
});
document.getElementById("projectTitleWrap").addEventListener("dblclick",(e)=>{
  if(e.target.id==="projectTitle") beginProjectTitleEdit();
});

document.getElementById("playBtn").addEventListener("click", togglePlayPause);
document.getElementById("holdPosBtn").addEventListener("click",()=>{
  state.holdPositionOnPause = !state.holdPositionOnPause;
  document.getElementById("holdPosBtn").classList.toggle("on", state.holdPositionOnPause);
  toast(state.holdPositionOnPause ? "Pause holds playhead position" : "Pause resets playhead to start");
});

/* exported to the shared namespace */
Object.assign(BB, { renderProjectTitle, syncSubHeaderLayout });
})();

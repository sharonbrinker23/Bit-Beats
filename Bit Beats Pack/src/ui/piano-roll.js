/* Bit Beats — the note grid: row labels, canvas, note tiles, zoom and mode transposition
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { GRID_RULER_H, NOTE_NAMES, OCT_MAX, OCT_MIN, ROW_H, SCALES, STEPS_TOTAL_BASE, STEP_W_MAX, STEP_W_MIN,
        state } = BB;
const midiToName = (...a)=> BB.midiToName(...a), selectedTrack = (...a)=> BB.selectedTrack(...a),
      renderPlayheads = (...a)=> BB.renderPlayheads(...a), buildTrackList = (...a)=> BB.buildTrackList(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a);
/* ======================================================================
   PIANO ROLL: ROW LABELS
   ====================================================================== */
const TOTAL_ROWS = (OCT_MAX-OCT_MIN+1)*12; // full chromatic range
const TOP_MIDI = (OCT_MAX+2)*12-1; // highest midi shown at row 0
function rowToMidi(row){ return TOP_MIDI-row; }
function midiToRow(midi){ return TOP_MIDI-midi; }

function scaleSemitones(){ return SCALES[state.mode] || SCALES.Major; }
function isInScale(midi){
  const keyIdx = NOTE_NAMES.indexOf(state.key);
  const rel = ((midi - keyIdx)%12+12)%12;
  return scaleSemitones().includes(rel);
}

/* ---------- MODE SWITCHING: transposition by nearest pitch ----------
   Changing the project's mode is meant to move the MUSIC into the new mode, not just recolour which
   rows count as in-scale. The rule is a single one: a note that ALREADY belongs to the new mode does not
   move at all, and any other note moves to the CLOSEST pitch that does belong to it, ties going to the
   lower candidate. C D E F G A B in C Major comes out as C D D# F G G# A# in C Minor — the thirds,
   sixths and sevenths that define a mode are exactly the notes that are out of the new scale and so
   exactly the notes that move, while the degrees the two modes agree on stay put.

   This replaced a mapping by scale-degree INDEX (find the note's index in the old scale, take the same
   index out of the new one; anchor anything that was not a degree to the nearest degree below it and
   carry its chromatic offset across). That could land a note on a pitch that is not in the target scale
   AT ALL, which is the one thing a mode switch must never do: with the Key select on C# and a run
   written in C, Minor -> Major produced D, G and B, none of which are members of C# major. Notes and the
   Key select disagreeing is normal — nothing forces the user to write in the key they picked — so the
   mapping has to be defined for all twelve pitches, not just for the seven that happen to be degrees of
   whatever the source scale was. Nearest-pitch snapping is defined for all twelve by construction, and
   every note it produces is by definition a member of the new mode.

   Chromatic needs no special case at either end: every pitch is a member of Chromatic, so switching TO
   it hits the "already belongs" branch for every note and is a no-op for free, and switching FROM it is
   just the general rule applied to a part that happens to use accidentals.

   Snapping is many-to-one and therefore NOT reversible: Major->Minor->Major turns E into D# and then
   into D (D# is one semitone from both D and E, and ties go down), so a round trip is not guaranteed to
   land back on the notes it started from. That is inherent to "every note must exist in the new mode" —
   the seven-of-twelve target simply has fewer places to put a note than the source had — and undo, not
   a return trip through the Mode select, is what puts a switch back exactly. */
function transposePitchBetweenModes(pitch, keyIdx, toScale, fromScale){
  // `rel` is the note's position inside its own key-relative octave and `base` carries everything else
  // (the octave AND the key offset), so rebuilding the pitch as base+newRel keeps each note in the very
  // same octave it started in instead of letting it drift up or down one.
  const rel = ((pitch - keyIdx)%12+12)%12;
  const base = pitch - rel;
  if(toScale.includes(rel)) return pitch; // in the new mode already — the rule says it must not move
  // Nearest member wins. toScale is ascending and the comparison is strict, so an exact tie keeps the
  // candidate seen FIRST, i.e. the lower one. 12 — the tonic an octave up — is offered as a candidate
  // too, because a rel sitting just under the top of the octave can genuinely be closer to it than to
  // anything below; since ties go down it can only ever win by being STRICTLY closer.
  let best = toScale[0];
  for(let i=1;i<toScale.length;i++){ if(Math.abs(toScale[i]-rel) < Math.abs(best-rel)) best = toScale[i]; }
  if((12-rel) < Math.abs(best-rel)) best = 12;
  // TIES are where the mode switch decides whether it can be walked back. A note exactly between two
  // scale tones has no "nearest", and always taking the lower one makes the operation lossy in a way
  // the user feels immediately: E -> D# going Major->Minor, but D# -> D coming back, so toggling the
  // mode a few times walks the melody downwards. When the note DID hold a degree in the mode we are
  // leaving, that degree is the tie-break — it sends the note to the same position in the new mode,
  // which is both the musically expected answer and an exact inverse. This only ever decides ties, so
  // nearest-pitch is still what guarantees every note lands inside the new mode.
  const degreeTie = fromScale ? fromScale.indexOf(rel) : -1;
  if(degreeTie!==-1 && degreeTie < toScale.length){
    const byDegree = toScale[degreeTie];
    if(Math.abs(byDegree-rel) === Math.abs(best-rel)) best = byDegree;
  }
  const out = base + best;
  // picking that octave-up tonic (or snapping downward in a non-C key) is the only way this can leave
  // the pitch range the grid can actually draw, so clamp it the same way importMidiTracks does
  return Math.max(TOP_MIDI-TOTAL_ROWS+1, Math.min(TOP_MIDI, out));
}
// Sweeps every note of every track — mode is a PROJECT setting, so the switch applies to the whole
// project, not just the selected track. Returns how many NOTES were touched (a note whose slur target
// moved counts once, like the single tile it draws as), so the caller can tell a switch worth an undo
// checkpoint from one that changed nothing (Major→Lydian only ever touches degree 3, so a part that
// never plays it comes out identical).
function transposeProjectToMode(fromMode, toMode){
  // The DESTINATION scale decides where a pitch lands — "where does this note live in the new mode" is
  // a question the old mode has no vote in. The source scale is consulted for one thing only: breaking
  // an exact tie by scale degree, which is what makes switching back and forth reversible instead of
  // walking the melody downwards a semitone at a time (see transposePitchBetweenModes).
  const toScale = SCALES[toMode] || SCALES.Major;
  const fromScale = SCALES[fromMode] || SCALES.Major;
  const keyIdx = Math.max(0, NOTE_NAMES.indexOf(state.key));
  let moved = 0;
  state.tracks.forEach(track=>{
    let trackMoved = false;
    track.notes.forEach(n=>{
      let touched = false;
      const p = transposePitchBetweenModes(n.pitch, keyIdx, toScale, fromScale);
      if(p!==n.pitch){ n.pitch = p; touched = true; }
      // a slur target is a real pitch drawn on the grid (renderNotes places the stub at
      // midiToRow(bendTo)), so it has to travel by the same rule — otherwise the note would land in the
      // new mode while the pitch it slides into stayed behind in the old one
      if(n.bendTo!=null){
        const b = transposePitchBetweenModes(n.bendTo, keyIdx, toScale, fromScale);
        if(b!==n.bendTo){ n.bendTo = b; touched = true; }
      }
      if(touched){ moved++; trackMoved = true; }
    });
    // Snapping is many-to-one — two notes a semitone apart can be pulled onto the same pitch. When that
    // happens at the SAME step in the SAME track the pair occupies one grid cell: only one tile draws,
    // and the note underneath can never be clicked, dragged or deleted again while still sounding. Merge
    // those exact duplicates instead of leaving a dead tile behind, keeping the LONGER dur so the
    // survivor still covers everything the pair used to sound. Notes sharing a pitch at DIFFERENT steps
    // are a repeated note, not a collision, and are left alone. Only tracks this sweep actually moved
    // something in are de-duplicated: it is not a mode switch's business to silently delete duplicates
    // it did not create.
    if(trackMoved){
      const firstAtCell = new Map();
      track.notes = track.notes.filter(n=>{
        const cell = n.step+":"+n.pitch;
        const keeper = firstAtCell.get(cell);
        if(!keeper){ firstAtCell.set(cell, n); return true; }
        if(n.dur > keeper.dur) keeper.dur = n.dur;
        BB.selectedNoteIds.delete(n.id); // the tile it was selected through is gone with it
        return false;
      });
    }
  });
  return moved;
}

function buildPianoLabels(){
  const inner = document.getElementById("pianoColInner");
  inner.style.height = (TOTAL_ROWS*ROW_H)+"px";
  inner.innerHTML="";
  for(let row=0; row<TOTAL_ROWS; row++){
    const midi = rowToMidi(row);
    const name = NOTE_NAMES[((midi%12)+12)%12];
    const oct = Math.floor(midi/12)-1;
    const div = document.createElement("div");
    div.className="pianoRowLabel"+(name==="C"?" c-row":"")+(isInScale(midi)?" in-scale":"");
    div.style.top=(row*ROW_H)+"px"; div.style.height=ROW_H+"px";
    div.textContent = name==="C" ? ("C"+oct) : name.replace("#","♯");
    div.dataset.midi = midi;
    const isNatural = name.indexOf("#")===-1;
    // C4 (Middle C) gets its own amber tint so it reads as a landmark row instead of blending into
    // every other C — every other C, C3 included, stays the same blue as the rest
    div.style.background = (name==="C" && oct===4) ? "var(--row-c4)" : (name==="C" ? "var(--row-c)" : (isNatural ? "var(--row-light)" : "var(--row-dark)"));
    inner.appendChild(div);
  }
}

/* ======================================================================
   PIANO ROLL: GRID CANVAS + NOTES
   ====================================================================== */
const gridScroll = document.getElementById("gridScroll");
const gridInner = document.getElementById("gridInner");
const gridCanvas = document.getElementById("gridCanvas");
const noteLayer = document.getElementById("noteLayer");
const pianoCol = document.getElementById("pianoCol");

function stepsPerBeat(){ return 4; } // grid resolution fixed at 16th notes
function beatsPerBar(){ return state.timeSig[0]; }
function stepsPerBar(){ return beatsPerBar()*stepsPerBeat()*(4/state.timeSig[1]); }

function sizeGrid(){
  const w = BB.STEPS_TOTAL*BB.STEP_W, h = TOTAL_ROWS*ROW_H;
  // gridInner reserves real space for the ruler (GRID_RULER_H) on top of the row content — the canvas
  // and note layer themselves stay sized to just the rows (h) and are pushed down via their own CSS
  // top offset, so nothing here needs to know about the ruler except the container's total height
  gridInner.style.width=w+"px"; gridInner.style.height=(h+GRID_RULER_H)+"px";
  gridCanvas.width=w; gridCanvas.height=h; gridCanvas.style.width=w+"px"; gridCanvas.style.height=h+"px";
  noteLayer.style.width=w+"px"; noteLayer.style.height=h+"px";
  drawGridLines();
  drawGridRuler();
}

// bar-number ruler pinned atop the piano roll grid itself — same idea as the arrange view's ruler,
// but scaled to STEP_W (which changes with zoom) instead of the arrange view's fixed BAR_PX, since it
// shares the note grid's own horizontal coordinate space
function drawGridRuler(){
  const ruler = document.getElementById("gridRuler");
  if(!ruler) return;
  const totalW = BB.STEPS_TOTAL*BB.STEP_W;
  const h = 18, dpr = window.devicePixelRatio||1;
  const canvas = document.createElement("canvas");
  canvas.width = totalW*dpr; canvas.height = h*dpr;
  canvas.style.width = totalW+"px"; canvas.style.height = h+"px";
  ruler.innerHTML = ""; ruler.appendChild(canvas);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,totalW,h);
  const spb = stepsPerBar(), beats = beatsPerBar(), barPx = spb*BB.STEP_W;
  const totalBars = Math.ceil(BB.STEPS_TOTAL/spb);
  ctx.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
  ctx.textBaseline = "top";
  for(let bar=0; bar<totalBars; bar++){
    const x = bar*barPx;
    ctx.strokeStyle = "#5a5a68"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+.5, 0); ctx.lineTo(x+.5, h); ctx.stroke();
    ctx.fillStyle = "#b7b7c2";
    ctx.fillText(String(bar+1), x+4, 2);
    ctx.strokeStyle = "#3a3a44";
    for(let b=1; b<beats; b++){
      const bx = x + b*(barPx/beats);
      ctx.beginPath(); ctx.moveTo(bx+.5, h*0.6); ctx.lineTo(bx+.5, h); ctx.stroke();
    }
  }
}

// grow the timeline (grid + ruler) to keep some empty room past whatever the furthest note/track content reaches —
// never shrinks back on its own, so the ruler/grid never "run out" as parts extend beyond the original 16 bars
// if a track has been split into regions, make sure a newly-added note always falls inside one —
// growing the nearest region to cover it rather than leaving the note invisible in the track list
function extendRegionsForNote(track, note){
  if(!track.regions || !track.regions.length) return;
  if(track.regions.some(r=> note.step>=r.start && note.step<r.end)) return;
  let nearest = track.regions[0], nearestDist = Infinity;
  track.regions.forEach(r=>{
    const mid = (r.start+r.end)/2, dist = Math.abs(note.step-mid);
    if(dist<nearestDist){ nearestDist=dist; nearest=r; }
  });
  if(note.step < nearest.start) nearest.start = note.step;
  if(note.step+note.dur > nearest.end) nearest.end = note.step+note.dur;
}

function recomputeStepsTotal(){
  let maxEnd = STEPS_TOTAL_BASE;
  state.tracks.forEach(t=> t.notes.forEach(n=>{ maxEnd = Math.max(maxEnd, n.step+n.dur); }));
  const spb = stepsPerBar();
  const needed = Math.ceil(maxEnd/spb)*spb + spb*4;
  if(needed > BB.STEPS_TOTAL){
    BB.STEPS_TOTAL = needed;
    sizeGrid();
    buildTrackList();
  }
}

// zoom the tile grid horizontally (trackpad pinch or the zoom slider), keeping the view centered on the same step
function setZoom(newStepW){
  newStepW = Math.max(STEP_W_MIN, Math.min(STEP_W_MAX, Math.round(newStepW)));
  if(newStepW===BB.STEP_W) return;
  const centerStep = (gridScroll.scrollLeft + gridScroll.clientWidth/2)/BB.STEP_W;
  BB.STEP_W = newStepW;
  sizeGrid();
  renderNotes();
  renderPlayheads();
  gridScroll.scrollLeft = Math.max(0, centerStep*BB.STEP_W - gridScroll.clientWidth/2);
  const zs = document.getElementById("zoomSlider");
  if(zs) zs.value = BB.STEP_W;
}
// Row-background colors live in style.css (:root) so the label column (buildPianoLabels) can read them
// directly via var(...). A canvas fillStyle can't take a CSS custom property, so drawGridLines resolves
// the SAME variables once here via getComputedStyle instead of hardcoding a second copy of each color —
// two hand-typed copies is exactly how the label column and the canvas drifted apart before (one read
// --row-c3 while the other had "#34343e" typed out separately, and nothing kept them in sync when the
// landmark row moved from C3 to C4). Resolved once at load: :root never changes at runtime, and reading
// getComputedStyle inside the per-row loop below would be needless work 96 times on every redraw.
const ROW_BG = (function(){
  const cs = getComputedStyle(document.documentElement);
  const v = name=> cs.getPropertyValue(name).trim();
  return { c4: v("--row-c4"), c: v("--row-c"), light: v("--row-light"), dark: v("--row-dark") };
})();
function drawGridLines(){
  const ctx = gridCanvas.getContext("2d");
  const w=gridCanvas.width, h=gridCanvas.height;
  ctx.clearRect(0,0,w,h);
  // row backgrounds: alternate light gray (natural notes) / dark gray (sharps), with C4 (Middle C)
  // picked out in amber as the landmark row — every other C, C3 included, gets the same blue as the rest
  for(let row=0; row<TOTAL_ROWS; row++){
    const midi = rowToMidi(row);
    const name = NOTE_NAMES[((midi%12)+12)%12];
    const oct = Math.floor(midi/12)-1;
    const isNatural = name.indexOf("#")===-1;
    ctx.fillStyle = (name==="C" && oct===4) ? ROW_BG.c4 : (name==="C" ? ROW_BG.c : (isNatural ? ROW_BG.light : ROW_BG.dark));
    ctx.fillRect(0,row*ROW_H,w,ROW_H);
  }
  // horizontal separators
  ctx.strokeStyle="#000000"; ctx.lineWidth=1;
  for(let row=0; row<=TOTAL_ROWS; row++){
    ctx.beginPath(); ctx.moveTo(0,row*ROW_H+.5); ctx.lineTo(w,row*ROW_H+.5); ctx.stroke();
  }
  // vertical step/beat/bar lines
  const spb = stepsPerBar(), spBeat = stepsPerBeat();
  for(let s=0;s<=BB.STEPS_TOTAL;s++){
    const isBar = s%spb===0, isBeat = s%spBeat===0;
    ctx.strokeStyle = isBar? "#5a5a68" : (isBeat? "#3a3a44" : "#26262e");
    ctx.lineWidth = isBar?1.4:1;
    ctx.beginPath(); ctx.moveTo(s*BB.STEP_W+.5,0); ctx.lineTo(s*BB.STEP_W+.5,h); ctx.stroke();
  }
}

// clamps a slurred note's bend-start offset (in steps, relative to note.step) to stay within the tile —
// leaves a small sliver at the end so the slide is never squashed down to nothing
function clampedBendStartStep(note){
  const max = Math.max(0, note.dur-0.15);
  return Math.max(0, Math.min(max, note.bendStartStep||0));
}
// clamps where the slide finishes (in steps, relative to note.step) — must land after the start point
// and never past the note's own end; defaults to the note's end (the slide fills the whole tail, same
// as the original always-ramps-to-the-last-instant behavior)
function clampedBendEndStep(note){
  const min = clampedBendStartStep(note)+0.15;
  const max = note.dur;
  const raw = note.bendEndStep==null ? note.dur : note.bendEndStep;
  return Math.max(min, Math.min(max, raw));
}

// The Note Length dropdown doubles as a property editor for the selection (see its change handler), so
// it has to READ as one too: with notes selected it shows their length, and with nothing selected it
// falls back to the length the next placed note will get. Driven from renderNotes() because that is
// what every selection change already goes through.
function syncNoteLenSelToSelection(){
  const sel = document.getElementById("noteLenSel"); if(!sel) return;
  const track = selectedTrack();
  if(track && BB.selectedNoteIds.size){
    const durs = track.notes.filter(n=>BB.selectedNoteIds.has(n.id)).map(n=>n.dur);
    if(!durs.length) return;
    // mixed lengths — or a dragged-out length like 3 steps that no option represents — leave the
    // dropdown exactly as it is, rather than blanking it out with a value it has no <option> for
    if(durs.every(d=>d===durs[0]) && Array.prototype.some.call(sel.options, o=>Number(o.value)===durs[0])){
      sel.value = String(durs[0]);
    }
    return;
  }
  sel.value = String(state.noteLenSteps);
}

function renderNotes(){
  noteLayer.innerHTML="";
  BB.selectedNoteIds.forEach(id=>{ if(!selectedTrack() || !selectedTrack().notes.some(n=>n.id===id)) BB.selectedNoteIds.delete(id); });
  syncNoteLenSelToSelection();
  const track = selectedTrack();
  if(!track) return;
  track.notes.forEach(note=>{
    const row = midiToRow(note.pitch);
    const hasBend = note.bendTo!=null && note.bendTo!==note.pitch;
    const div = document.createElement("div");
    div.className = "note"+(BB.selectedNoteIds.has(note.id)?" selected":"")+(hasBend?" bend":"");
    div.style.left=(note.step*BB.STEP_W+1)+"px";
    div.style.top=(row*ROW_H+1)+"px";
    div.style.width=(note.dur*BB.STEP_W-2)+"px";
    div.style.height=(ROW_H-2)+"px";
    div.style.background = hasBend
      ? "linear-gradient(to right, "+track.color+", var(--accent2))"
      : track.color;
    div.dataset.id = note.id;
    div.title = hasBend ? "Slurred: "+midiToName(note.pitch)+" → "+midiToName(note.bendTo) : midiToName(note.pitch);
    const leftGrip = document.createElement("div");
    leftGrip.className = "leftHandle";
    leftGrip.title = "Drag to trim the start of the note";
    div.appendChild(leftGrip);
    const grip = document.createElement("div");
    grip.className = "bendHandle";
    grip.title = "Drag sideways to resize, up/down to slur/tie into another pitch";
    div.appendChild(grip);
    noteLayer.appendChild(div);

    if(hasBend){
      const destRow = midiToRow(note.bendTo);
      // the stub stays a fixed one-16th-note cell — it doesn't stretch, it just translates left/right
      // across the tile, and wherever it lands marks the point where the slide finishes (bendEndStep)
      const bendEndStep = clampedBendEndStep(note);
      const stubW = BB.STEP_W-2;
      const stubRightRaw = note.step*BB.STEP_W + bendEndStep*BB.STEP_W + 1;
      const stubLeft = Math.max(note.step*BB.STEP_W+1, stubRightRaw-stubW);
      const stub = document.createElement("div");
      stub.className = "bendStub";
      stub.dataset.id = note.id;
      stub.title = "Drag sideways to change where the slide ends, up/down to change the slur target";
      stub.style.left = stubLeft+"px";
      stub.style.width = stubW+"px";
      stub.style.top = (destRow*ROW_H + 1)+"px";
      stub.style.height = (ROW_H-2)+"px";
      stub.style.background = "var(--accent2)";
      noteLayer.appendChild(stub);

      // the slide is drawn from the bend-start point (defaulting to the note's own left edge) rather than
      // always the note's start, so the slur can begin partway through the note. Its drag handle sits at
      // the top of the tile rather than at the row's vertical center — right on top of the row-center is
      // exactly where the leftHandle resize grip lives, so the dot used to win that hit-test and made it
      // hard to grab the resize handle near a slurred note's left edge
      const bendStartStep = clampedBendStartStep(note);
      const startDot = document.createElement("div");
      startDot.className = "bendStartHandle";
      startDot.dataset.id = note.id;
      startDot.title = "Drag to change where the slur begins";
      startDot.style.left = (note.step*BB.STEP_W + bendStartStep*BB.STEP_W + 1)+"px";
      startDot.style.top = (row*ROW_H + 5)+"px";
      noteLayer.appendChild(startDot);

      const svgNS = "http://www.w3.org/2000/svg";
      const x1 = note.step*BB.STEP_W + bendStartStep*BB.STEP_W + 1, y1 = row*ROW_H+ROW_H/2;
      const x2 = note.step*BB.STEP_W + bendEndStep*BB.STEP_W + 1, y2 = destRow*ROW_H+ROW_H/2;
      const left = Math.min(x1,x2), top = Math.min(y1,y2);
      const w = Math.max(1,Math.abs(x2-x1)), h = Math.max(1,Math.abs(y2-y1));
      const svg = document.createElementNS(svgNS,"svg");
      svg.setAttribute("class","bendSlide");
      svg.style.left=left+"px"; svg.style.top=top+"px"; svg.style.width=w+"px"; svg.style.height=h+"px";
      svg.setAttribute("viewBox", "0 0 "+w+" "+h);
      const path = document.createElementNS(svgNS,"path");
      const lx1=x1-left, ly1=y1-top, lx2=x2-left, ly2=y2-top;
      path.setAttribute("d", "M"+lx1+","+ly1+" Q"+((lx1+lx2)/2)+","+ly2+" "+lx2+","+ly2);
      path.setAttribute("stroke","var(--accent2)");
      path.setAttribute("stroke-width","2");
      path.setAttribute("fill","none");
      path.setAttribute("stroke-linecap","round");
      svg.appendChild(path);
      noteLayer.appendChild(svg);
    }
  });

  if(BB.phantomSelection){
    const pdiv = document.createElement("div");
    pdiv.id = "phantomCell";
    pdiv.style.left = (BB.phantomSelection.step*BB.STEP_W+1)+"px";
    pdiv.style.top = (BB.phantomSelection.row*ROW_H+1)+"px";
    // the ghost spans the current Note Length, matching the duration a plain click would place
    pdiv.style.width = (state.noteLenSteps*BB.STEP_W-2)+"px";
    pdiv.style.height = (ROW_H-2)+"px";
    noteLayer.appendChild(pdiv);
  }

  // keep the advanced editor's ghost note tiles live instead of only refreshing on open/close —
  // cheap enough (small canvas) to just redraw every time the piano roll's notes change
  if(state.advancedTrackId!=null) renderAdvancedEditor();
}

function syncPianoScroll(){
  document.getElementById("pianoColInner").style.transform = "translateY("+(-gridScroll.scrollTop)+"px)";
}
gridScroll.addEventListener("scroll", syncPianoScroll);

/* exported to the shared namespace */
Object.assign(BB, { beatsPerBar, buildPianoLabels, clampedBendEndStep, clampedBendStartStep, drawGridLines,
                    drawGridRuler, extendRegionsForNote, gridCanvas, gridInner, gridScroll, midiToRow,
                    noteLayer, recomputeStepsTotal, renderNotes, rowToMidi, setZoom, sizeGrid, stepsPerBar,
                    syncPianoScroll, TOP_MIDI, TOTAL_ROWS, transposeProjectToMode });
})();

/* Bit Beats — the instrument list and the arrange view's track blocks
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { state } = BB;
const findSample = (...a)=> BB.findSample(...a), beatsPerBar = (...a)=> BB.beatsPerBar(...a),
      stepsPerBar = (...a)=> BB.stepsPerBar(...a), renderLoopUI = (...a)=> BB.renderLoopUI(...a),
      renderPlayheads = (...a)=> BB.renderPlayheads(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a), hexToRgb = (...a)=> BB.hexToRgb(...a);
/* ======================================================================
   INSTRUMENT LIST (left panel) + TRACK LIST (right panel)
   ====================================================================== */
BB.BAR_PX = 60; // track-list horizontal zoom — pixels per bar (independent of vertical row shrink)
let TRACK_ROW_H = 46; // shared instrument-row / track-row height — independent of BAR_PX (vertical vs horizontal zoom)
const TRACK_ROW_MIN = 34, TRACK_ROW_MAX = 90;
// Row shrink is a single threshold on the row's height:
//   H >  TRACK_ROW_COMPACT_MAX : full card — name header with the controls row beneath it
//   H <= TRACK_ROW_COMPACT_MAX : single line — controls move to the RIGHT of the name (never hidden);
//                                the name truncates and the waveform select abbreviates to make room
// Instrument rows carry no note preview at any height — the note pattern lives only in the track
// list's own preview blocks (renderTrackBlock) and the advanced editor's lane.
const TRACK_ROW_COMPACT_MAX = 45;
const TRACK_ROW_HDR_H = 22; // instrument-row name strip's height on full-size rows
// track-preview blocks: inset from their row's top/bottom, with an opaque colored header strip
// (mirroring #advLaneHeader) over a translucent body
const TRACK_BLOCK_INSET = 3;
const TRACK_BLOCK_HDR_H = 14;
const BAR_PX_MIN = 20, BAR_PX_MAX = 200;
function refreshArrangeGridBg(){
  document.querySelectorAll(".trackRow").forEach(r=> r.style.setProperty("--barpx", BB.BAR_PX+"px"));
}
function setTrackRowHeight(h){
  TRACK_ROW_H = Math.max(TRACK_ROW_MIN, Math.min(TRACK_ROW_MAX, Math.round(h)));
  renderInstrumentList();
}
// zoom the track list horizontally — the arrange-view counterpart of setZoom(), driven by either the
// #trackZoomSlider or the same ctrl+wheel / trackpad-pinch gesture the piano roll uses
function setTrackZoom(px){
  const next = Math.max(BAR_PX_MIN, Math.min(BAR_PX_MAX, Math.round(px)));
  // a pinch gesture fires dozens of wheel events per second, most of which round to the same integer —
  // bailing here keeps those from each rebuilding the whole track list for no visible change
  if(next===BB.BAR_PX) return;
  BB.BAR_PX = next;
  buildTrackList();
  // the automation lane is measured in BAR_PX too (its width, its curve and its draggable dots all come
  // off stepToX), so it has to be redrawn with the track list or it keeps painting the previous zoom
  // until something else happens to refresh it. Cheap when closed — renderAdvancedEditor bails at once.
  renderAdvancedEditor();
  // keep the slider showing the zoom the wheel gesture just landed on, mirroring setZoom/#zoomSlider
  const ts = document.getElementById("trackZoomSlider");
  if(ts) ts.value = BB.BAR_PX;
}

// translucent variant of a track color for the row body (the opaque header keeps the raw color)
function colorWithAlpha(color, a){
  if(typeof color==="string" && /^#?[0-9a-f]{6}$/i.test(color)){
    const [r,g,b] = hexToRgb(color);
    return "rgba("+r+","+g+","+b+","+a+")";
  }
  return color; // non-hex (named/rgb) colors: fall back to the raw value rather than mangling it
}

// lighter tint of a track color, for the note-pattern tiles drawn BY drawNotePattern on top of a
// colorWithAlpha(...,.35) body of that same track color (see renderTrackBlock / renderAdvancedEditor).
// Blending toward white before applying alpha — rather than just applying alpha to the raw color, the
// way colorWithAlpha does for the body — is what keeps a tile reading as a lighter shape ON its body
// instead of converging back onto the body's own shade; a dark custom track color needs this most, but
// every palette color reads better lifted a little toward white too.
function noteTint(color, a){
  if(typeof color==="string" && /^#?[0-9a-f]{6}$/i.test(color)){
    const [r,g,b] = hexToRgb(color);
    const mix = 0.6; // fraction of the way from the track color to white
    const lr = Math.round(r+(255-r)*mix), lg = Math.round(g+(255-g)*mix), lb = Math.round(b+(255-b)*mix);
    return "rgba("+lr+","+lg+","+lb+","+a+")";
  }
  return colorWithAlpha(color, a); // non-hex (named/rgb) colors: fall back rather than mangling it
}

function renderInstrumentList(){
  const list = document.getElementById("instrumentList");
  // this function rebuilds the list's DOM from scratch, which resets its scroll container to the top —
  // stash and restore the scroll offset so unrelated rerenders (mute/solo/rename/volume) don't yank
  // the user back to the first instrument. selectTrack() overrides this with a centering scroll.
  const scroller = document.getElementById("instrumentListScroll");
  const keepScrollTop = scroller ? scroller.scrollTop : 0;
  list.innerHTML="";
  const oneline = TRACK_ROW_H<=TRACK_ROW_COMPACT_MAX;
  const hdrH = oneline ? TRACK_ROW_H-1 : TRACK_ROW_HDR_H;
  state.tracks.forEach(track=>{
    const row = document.createElement("div");
    row.className="instrumentRow"+(track.id===state.selectedTrackId?" selected":"")+(oneline?" oneline":"");
    row.dataset.id = track.id;
    row.style.height = TRACK_ROW_H+"px";
    row.style.setProperty("--hdrh", hdrH+"px");
    // the name is plain text until double-clicked (see the dblclick handler on #instrumentList),
    // which swaps in a bordered <input> for the duration of the edit
    row.innerHTML = `
      <div class="tname"><span class="swatch" style="background:${track.color}"></span>
        <span class="nameText" data-role="nameText" title="Double-click to rename">${escapeHtml(track.name)}</span></div>
      <div class="tctrls">
        <button class="mutebtn ${track.muted?'on':''}" data-role="mute">M</button>
        <button class="solobtn ${track.solo?'on':''}" data-role="solo">S</button>
        <select data-role="wave">
          <option value="square">Square</option><option value="pulse25">Pulse25</option>
          <option value="pulse12">Pulse12</option><option value="triangle">Triangle</option>
          <option value="sawtooth">Saw</option><option value="sine">Sine</option>
          <option value="noise">Noise</option>
        </select>
        <input type="range" data-role="vol" min="0" max="100" value="${Math.round(track.volume*100)}">
      </div>`;
    // the sample options are appended (and the value set) here rather than baked into the template
    // string above, because they are project state, not markup — see syncWaveCustomOptions
    syncWaveCustomOptions(row.querySelector('[data-role=wave]'), track.instrument, "Custom");
    list.appendChild(row);
  });
  // second pass, after the rows are in the document and have a measurable layout
  list.querySelectorAll(".instrumentRow").forEach(row=>{
    sizeNameInput(row.querySelector('[data-role=nameText], input[data-role=name]'));
    fitRowControls(row);
  });
  if(scroller) scroller.scrollTop = keepScrollTop;
  buildTrackList();
}
// scrolls the instrument list so the selected row sits in the middle of the visible area, clamped to
// the real scroll range (so the first/last rows just sit at the top/bottom rather than being forced
// past the ends). Called after the list has been rebuilt, since rebuilding resets scrollTop.
function centerSelectedInstrumentRow(opts){
  const scroller = document.getElementById("instrumentListScroll");
  if(!scroller || state.selectedTrackId==null) return;
  const row = scroller.querySelector('.instrumentRow[data-id="'+state.selectedTrackId+'"]');
  if(!row) return;
  if(opts && opts.onlyIfOffscreen){
    const r = row.getBoundingClientRect(), v = scroller.getBoundingClientRect();
    // the sticky header spacer covers the top of the viewport, so "visible" starts below it
    const spacerH = (document.getElementById("instrumentListHeaderSpacer")||{offsetHeight:0}).offsetHeight;
    if(r.top >= v.top+spacerH-0.5 && r.bottom <= v.bottom+0.5) return;
  }
  // measured rather than derived from offsetTop: neither #instrumentListScroll nor #instrumentList is
  // a positioned element, so offsetParent would be the body and offsetTop would be page-relative
  const rowRect = row.getBoundingClientRect(), viewRect = scroller.getBoundingClientRect();
  const rowTopInContent = rowRect.top - viewRect.top + scroller.scrollTop;
  const target = rowTopInContent - (scroller.clientHeight - rowRect.height)/2;
  scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, target));
}
function escapeHtml(s){ const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }

/* ---------- name box sizes itself to its text (no wide empty click strip) ---------- */
let _measureCtx = null;
function measureTextPx(text, font){
  if(!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}
// works for both states of the name box: the plain <span> shown normally and the <input> swapped in
// while it's being edited (see beginNameEdit) — both need the same measured, text-hugging width
function sizeNameInput(el){
  if(!el) return;
  const cs = getComputedStyle(el);
  const text = (el.tagName==="INPUT" ? el.value : el.textContent) || " ";
  const w = measureTextPx(text, cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily);
  const pad = (parseFloat(cs.paddingLeft)||0) + (parseFloat(cs.paddingRight)||0)
            + (parseFloat(cs.borderLeftWidth)||0) + (parseFloat(cs.borderRightWidth)||0);
  const natural = Math.max(10, Math.ceil(w+pad)+3);
  // max-width:100% + flex-shrink still let this give up space to the controls when the row is tight,
  // so the *rendered* width is not a usable measurement — stash the unsqueezed one for fitRowControls
  el.dataset.natw = String(natural);
  if(el.tagName==="INPUT") el.style.width = natural+"px";
}

/* ---------- waveform <select>: the "custom" end of the option list ----------
   Once the project has uploads, the single generic "Custom" entry is replaced by ONE OPTION PER SAMPLE,
   labelled with that sample's name — so choosing an instrument and choosing which sample are the same
   gesture. Values are "custom:<id>", which can't collide with the seven fixed wave values nor with the
   bare "custom" that still means "this instrument is a sample" when no registry entry backs it.

   Labels are fitted to the select's own rendered width and then written into option.dataset.full. That
   is the handshake with applyWaveTier() below: it treats data-full as an option's TRUE label, so tier 0
   restores this already-shortened name (not the raw filename, which would overflow the row) and tier 1
   takes its first letter. */
const WAVE_SEL_ARROW_PX = 20; // room the native dropdown arrow claims beside an option's text
function fitSampleLabel(name, sel){
  const cs = getComputedStyle(sel);
  const font = cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily;
  const budget = (sel.clientWidth||0) - (parseFloat(cs.paddingLeft)||0) - (parseFloat(cs.paddingRight)||0)
               - WAVE_SEL_ARROW_PX;
  if(budget<=0 || measureTextPx(name, font)<=budget) return name;
  // drop characters until the name PLUS its ellipsis fits — the "…" is part of what has to fit, so it
  // is measured with the candidate rather than tacked on after the budget was already spent
  let cut = name.length;
  while(cut>1 && measureTextPx(name.slice(0,cut)+"…", font) > budget) cut--;
  return name.slice(0,cut)+"…";
}
function refreshWaveSampleLabels(sel){
  if(!sel) return;
  // measure against the select's UNABBREVIATED width: applyWaveTier's narrow tiers squeeze the box down
  // to 34/22px, and fitting names to that would bake a temporary squeeze into the stored labels
  sel.classList.remove("wtier1","wtier2");
  Array.prototype.forEach.call(sel.options, o=>{
    const s = findSample(Number(o.dataset.sample));
    if(!s) return; // fixed waves and the generic "custom" fallback keep their authored labels
    const label = fitSampleLabel(s.name, sel);
    o.dataset.full = label;
    o.textContent = label;
  });
}
function waveSelValue(inst){
  if(inst.wave!=="custom") return inst.wave;
  return findSample(inst.sampleId) ? "custom:"+inst.sampleId : "custom";
}
function syncWaveCustomOptions(sel, inst, genericLabel){
  if(!sel) return;
  Array.prototype.slice.call(sel.querySelectorAll("option[data-sample]")).forEach(o=>o.remove());
  const resolved = inst ? findSample(inst.sampleId) : null;
  // the plain option survives exactly two cases: a project with no uploads at all (so a fresh project
  // reads exactly as it always did), and a track whose wave is "custom" with nothing in the registry
  // behind it — save files carry no audio data, so a reloaded project lands there, and without this
  // fallback its select would render blank
  if(!state.samples.length || (inst && inst.wave==="custom" && !resolved)){
    const o = document.createElement("option");
    o.value = "custom"; o.textContent = genericLabel; o.dataset.sample = "generic";
    sel.appendChild(o);
  }
  state.samples.forEach(s=>{
    const o = document.createElement("option");
    o.value = "custom:"+s.id; o.dataset.sample = String(s.id); o.textContent = s.name;
    sel.appendChild(o);
  });
  refreshWaveSampleLabels(sel);
  if(inst) sel.value = waveSelValue(inst);
}
// translates a waveform <select>'s value back onto the instrument. Binding the registry entry's buffer
// to instrument.customBuffer here is what keeps playNote()'s `wave==="custom" && customBuffer` branch
// working unchanged — the audio path never learns that a registry exists.
function applyWaveSelection(inst, value){
  const m = /^custom:(\d+)$/.exec(value);
  if(m){
    const s = findSample(Number(m[1]));
    inst.wave = "custom";
    if(s){ inst.sampleId = s.id; inst.customBuffer = s.buffer; }
    return;
  }
  inst.wave = value;
}

/* ---------- waveform <select> progressive abbreviation ----------
   Tier 0 = full word ("Square"), 1 = first letter only ("S"), 2 = no text at all (bare dropdown arrow).
   A plain <select> renders whatever text the *selected* <option> holds, so abbreviating means
   rewriting that option's label; the original is stashed in data-full and restored whenever the
   popup is about to open (mousedown/focus) so the list itself always reads in full words. */
function applyWaveTier(sel, tier){
  if(!sel) return;
  Array.prototype.forEach.call(sel.options, o=>{
    if(o.dataset.full===undefined) o.dataset.full = o.textContent;
    o.textContent = o.dataset.full;
  });
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  if(opt){
    if(tier===1) opt.textContent = (opt.dataset.full||"").charAt(0);
    else if(tier>=2) opt.textContent = "";
  }
  sel.classList.toggle("wtier1", tier===1);
  sel.classList.toggle("wtier2", tier>=2);
}
// shrink the waveform label (and, last resort, the volume slider) until the controls fit beside the name
function fitRowControls(row){
  if(!row) return;
  const ctrls = row.querySelector(".tctrls"), name = row.querySelector(".tname");
  const sel = ctrls && ctrls.querySelector('select[data-role=wave]');
  const vol = ctrls && ctrls.querySelector('input[data-role=vol]');
  if(!ctrls || !name || !sel) return;
  // sample labels are width-derived, and this is the one function every path that changes a row's width
  // already goes through (rebuild, instrument-column resize, select focusout) — so re-fit them here,
  // before the tier loop below starts rewriting the selected option's text
  refreshWaveSampleLabels(sel);
  if(!row.classList.contains("oneline")){
    sel.dataset.wtier = "0"; applyWaveTier(sel, 0);
    if(vol) vol.classList.remove("volNarrow");
    return;
  }
  if(vol) vol.classList.remove("volNarrow");
  // natural (unshrunk) width the name wants: left padding + swatch + gap + measured text.
  // name.scrollWidth would be useless here — the flex shrink has already squashed the input.
  const nameEl = name.querySelector('[data-role=nameText], input[data-role=name]');
  const nameNeed = 8 + 9 + 6 + (nameEl ? Number(nameEl.dataset.natw||0) : 0);
  const avail = row.clientWidth;
  let tier = 0;
  for(tier=0; tier<=2; tier++){
    applyWaveTier(sel, tier);
    if(nameNeed + ctrls.offsetWidth <= avail) break;
  }
  if(tier>2) tier = 2;
  sel.dataset.wtier = String(tier);
  if(tier===2 && vol && nameNeed + ctrls.offsetWidth > avail) vol.classList.add("volNarrow");
}

/* ---------- instrument-editor top row: progressive label truncation ----------
   Same measure-and-shrink idea as fitRowControls above, applied to the two buttons in .instTopRow,
   because #instEditor's width is drag-resizable (see makeResizer on #vResizerInstEditor) and the row
   has nowhere to wrap to. The full word lives in data-full and every pass restarts from it, which is
   what makes widening the panel back out restore the whole label AND drop the ellipsis — the "…" is
   never decoration, it appears only on a label that actually had to give up characters. */
const INST_LABEL_MIN_CHARS = 1; // floor: one character plus the ellipsis ("A…") — never shorter, never hidden
// a button's box is its fixed chrome (padding + border) plus the measured label, so a candidate label's
// width can be computed without laying it out first
function instBtnWidthFor(btn, text){
  const cs = getComputedStyle(btn);
  const chrome = (parseFloat(cs.paddingLeft)||0) + (parseFloat(cs.paddingRight)||0)
               + (parseFloat(cs.borderLeftWidth)||0) + (parseFloat(cs.borderRightWidth)||0);
  const w = measureTextPx(text, cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily);
  return Math.ceil(w + chrome) + 1;
}
function fitInstTopRow(){
  const row = document.querySelector("#instEditor .instTopRow");
  if(!row) return;
  // #sampleMenuBtn only exists in the row once the project has an upload, and it carries a real word
  // like the other two, so it joins the same shrink set — a hidden one is filtered out because
  // display:none takes it out of row.scrollWidth entirely, and shrinking it would burn passes for
  // nothing (it is re-fitted the moment it appears, via refreshInstrumentEditor -> updateSampleMenuBtn)
  const btns = ["advToggleBtn","uploadSampleBtn","sampleMenuBtn"].map(id=>document.getElementById(id))
    .filter(b=>b && !b.classList.contains("hidden"));
  if(!btns.length || !row.clientWidth) return;
  row.classList.remove("squeezed");
  btns.forEach(b=>{
    if(b.dataset.full===undefined) b.dataset.full = (b.textContent||"").trim();
    b.textContent = b.dataset.full;
    b.style.width = instBtnWidthFor(b, b.dataset.full)+"px";
  });
  // chop one character off whichever label still has the most left to give, so the two shrink in step
  // instead of the first one collapsing to "A…" while the second is still showing its full word
  let guard = 64, atFloor = false;
  while(row.scrollWidth > row.clientWidth && guard-- > 0){
    let victim = null, victimLen = INST_LABEL_MIN_CHARS;
    btns.forEach(b=>{
      const cur = b.textContent.replace(/…$/,"");
      if(cur.length > victimLen){ victim = b; victimLen = cur.length; }
    });
    if(!victim){ atFloor = true; break; } // every label is already down to its floor
    const next = victim.textContent.replace(/…$/,"").slice(0, victimLen-1) + "…";
    victim.textContent = next;
    victim.style.width = instBtnWidthFor(victim, next)+"px";
  }
  // both labels are at "A…" and the row STILL doesn't fit — hand the shortfall to the Track / Waveform
  // fields (see .instTopRow.squeezed) so the buttons stay on screen instead of being clipped off the end
  row.classList.toggle("squeezed", atFloor);
}

function buildTrackList(){
  const inner = document.getElementById("trackListInner");
  inner.innerHTML = "";
  const loopBar = document.createElement("div"); loopBar.id="loopBar";
  loopBar.innerHTML = '<div id="loopRegion"><div id="loopHandleL" class="loopHandle"></div><div id="loopHandleR" class="loopHandle"></div></div>';
  inner.appendChild(loopBar);
  const ruler = document.createElement("div"); ruler.id="trackListRuler"; inner.appendChild(ruler);
  const ph = document.createElement("div"); ph.id="trackListPlayhead"; inner.appendChild(ph);
  const flag = document.createElement("div"); flag.id="trackListPlayheadFlag"; inner.appendChild(flag);
  state.tracks.forEach(track=>{
    const row = document.createElement("div");
    row.className="trackRow"; row.style.setProperty("--barpx",BB.BAR_PX+"px");
    row.style.height = TRACK_ROW_H+"px";
    row.dataset.id = track.id;
    if(track.regions && track.regions.length){
      // split into independent regions: each renders as its own block, but all still belong to this one track
      track.regions.forEach(region=>{
        const regionNotes = track.notes.filter(n=> n.step>=region.start && n.step<region.end);
        renderTrackBlock(row, track, region.start, region.end, regionNotes, region.id);
      });
    } else if(track.notes.length){
      const spb = stepsPerBar();
      const minStep = Math.min(...track.notes.map(n=>n.step));
      const maxStep = Math.max(...track.notes.map(n=>n.step+n.dur));
      const startBar = Math.floor(minStep/spb)*spb, endBar = Math.ceil(maxStep/spb)*spb;
      renderTrackBlock(row, track, startBar, endBar, track.notes, null);
    }
    inner.appendChild(row);
  });
  const totalW = (BB.STEPS_TOTAL/stepsPerBar()*BB.BAR_PX+40);
  inner.style.width = totalW+"px";
  renderArrangeRuler(totalW);
  renderPlayheads();
  renderLoopUI();
}

// Shared mini note-pattern painter. The track list's preview blocks and the advanced editor's ghost
// tiles are meant to read as the same object, so the fill, the rounded tile shape and the pitch-driven
// vertical placement live here once instead of drifting apart in two copies. Only the HORIZONTAL
// mapping genuinely differs between the two, which is why it arrives as an xOf(step) callback rather
// than being computed in here: the advanced editor fits the whole note span into its visible lane
// rectangle, while a track block maps its own [startStep,endStep) across its own width.
// opts:
//   h            drawable height in CSS px (the caller has already dpr-scaled the context)
//   xOf(step)    step -> canvas x, the caller's own timeline mapping
//   padV         breathing room kept off the top/bottom edge, capped at a quarter of h below so a
//                short block's padding can't swallow the whole travel
//   minTileH/maxTileH  clamp on the pitch-derived tile height — the two callers pass very different
//                ranges because a ~15px block body and a ~160px lane cannot share one absolute size
//   minTileW     floor on a tile's width, so a one-step note never collapses to nothing
//   gap          px shaved off each tile's right edge, so back-to-back notes stay visually separate
//   tint         fillStyle for the tiles — a lighter tint of the OWNING track's color (see noteTint),
//                so a track's preview reads as belonging to that track instead of every track's notes
//                painting in the same fixed color regardless of which instrument they belong to
function drawNotePattern(ctx, notes, opts){
  if(!notes.length || opts.h<=0) return;
  const pitches = notes.map(n=>n.pitch);
  const minP = Math.min(...pitches), maxP = Math.max(...pitches);
  const range = Math.max(1, maxP-minP);
  const padV = Math.min(opts.padV, Math.floor(opts.h/4));
  const avail = Math.max(1, opts.h - padV*2);
  // taller tiles for a narrow pitch spread, thinner ones for a wide spread, so the stack of pitches
  // fills the available height without the tiles piling on top of each other
  const tileH = Math.max(opts.minTileH, Math.min(opts.maxTileH, avail, opts.h/(range+4)));
  const travel = Math.max(0, avail - tileH);
  ctx.fillStyle = opts.tint;
  notes.forEach(n=>{
    const x = opts.xOf(n.step);
    const w = Math.max(opts.minTileW, opts.xOf(n.step+n.dur)-x-opts.gap);
    const t = (n.pitch-minP)/range; // 0 = lowest pitch in this pattern, 1 = highest
    const y = (opts.h-padV-tileH) - t*travel;
    ctx.beginPath();
    ctx.roundRect(x, y, w, tileH, 2);
    ctx.fill();
  });
}

// renders one track block spanning [startStep,endStep) in a track's row of the track list, with a mini note-pattern preview
function renderTrackBlock(row, track, startStep, endStep, notes, regionId){
  const spb = stepsPerBar();
  const left = startStep/spb*BB.BAR_PX;
  const blockW = Math.max(20, (endStep-startStep)/spb*BB.BAR_PX);
  // the block is an opaque track-colored header strip (carrying the name) over a translucent
  // track-colored body — the treatment that used to live on the instrument-list rows
  const blockH = Math.max(16, TRACK_ROW_H - 1 - TRACK_BLOCK_INSET*2);
  const hdrH = Math.min(TRACK_BLOCK_HDR_H, Math.max(9, Math.round(blockH*0.45)));
  const bodyH = Math.max(0, blockH-hdrH);
  const block = document.createElement("div");
  // Two independent highlights, deliberately separate classes rather than one shared flag: every block
  // of the selected TRACK gets the white ring (that's the "you're editing this track" cue the piano
  // roll is bound to), while regionSelected marks the individual split-off regions in a multi-selection.
  // Both can be true on the same block at once, and neither can switch the other off.
  const selCls = (track.id===state.selectedTrackId ? " trackSelected" : "")
    + (regionId!=null && BB.selectedRegionIds.has(regionId) ? " regionSelected" : "");
  block.className = "trackBlock"+selCls;
  block.style.left = left+"px";
  block.style.top = TRACK_BLOCK_INSET+"px";
  block.style.width = blockW+"px";
  block.style.height = blockH+"px";
  block.style.boxSizing = "border-box";
  block.style.background = colorWithAlpha(track.color, 0.35);
  if(regionId!=null) block.dataset.regionId = regionId;

  const header = document.createElement("div");
  header.className = "trackBlockHeader";
  header.style.height = hdrH+"px";
  header.style.background = track.color;
  header.style.fontSize = (hdrH<12 ? 8 : 10)+"px";
  header.textContent = track.name;
  block.appendChild(header);

  const pattern = document.createElement("canvas");
  const dpr = window.devicePixelRatio||1;
  pattern.className = "trackBlockPattern";
  pattern.width = Math.max(1, Math.round(blockW*dpr)); pattern.height = Math.max(1, Math.round(bodyH*dpr));
  pattern.style.top = hdrH+"px";
  pattern.style.width=blockW+"px"; pattern.style.height=bodyH+"px";
  const pctx = pattern.getContext("2d"); pctx.scale(dpr,dpr);
  if(notes.length && bodyH>3){
    // A block already IS its notes' extent, so the pattern simply stretches [startStep,endStep) across
    // the block's own width — no inset span-fit like the advanced editor needs.
    const totalSteps = Math.max(1, endStep-startStep);
    // The body is a fraction of an automation lane's height (often only ~15-25px), so the lane's
    // 6-16px tile clamp would fill it edge to edge and read as one solid slab. Scale the clamp to the
    // body instead: never thinner than a 2px hairline, never taller than about a third of the body.
    const maxTileH = Math.max(2, Math.min(8, Math.round(bodyH*0.35)));
    drawNotePattern(pctx, notes, {
      h: bodyH, xOf: s=> (s-startStep)/totalSteps*blockW,
      padV: 3, minTileH: 2, maxTileH, minTileW: 1, gap: 0.5, tint: noteTint(track.color, 0.55)
    });
  }
  block.appendChild(pattern);

  // Deliberately no edge grips: a block's span is not directly resizable. Its length is derived from
  // the notes it contains (or from its region's bounds), and the way to make a block read longer or
  // shorter on screen is the track-zoom slider / pinch gesture, not dragging its edges. The whole
  // block surface is therefore a single drag target for MOVING it sideways.
  row.appendChild(block);
}

// bar-number ruler above the track list, marking measure boundaries
function renderArrangeRuler(totalW){
  const ruler = document.getElementById("trackListRuler");
  if(!ruler) return;
  const h = 18, dpr = window.devicePixelRatio||1;
  const canvas = document.createElement("canvas");
  canvas.width = totalW*dpr; canvas.height = h*dpr;
  canvas.style.width = totalW+"px"; canvas.style.height = h+"px";
  ruler.innerHTML = ""; ruler.appendChild(canvas);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,totalW,h);
  const spb = stepsPerBar(), beats = beatsPerBar();
  const totalBars = Math.ceil(BB.STEPS_TOTAL/spb);
  ctx.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
  ctx.textBaseline = "top";
  for(let bar=0; bar<totalBars; bar++){
    const x = bar*BB.BAR_PX;
    ctx.strokeStyle = "#5a5a68"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x+.5, 0); ctx.lineTo(x+.5, h); ctx.stroke();
    ctx.fillStyle = "#b7b7c2";
    ctx.fillText(String(bar+1), x+4, 2);
    ctx.strokeStyle = "#3a3a44";
    for(let b=1; b<beats; b++){
      const bx = x + b*(BB.BAR_PX/beats);
      ctx.beginPath(); ctx.moveTo(bx+.5, h*0.6); ctx.lineTo(bx+.5, h); ctx.stroke();
    }
  }
}

/* exported to the shared namespace */
Object.assign(BB, { applyWaveSelection, applyWaveTier, buildTrackList, centerSelectedInstrumentRow,
                    drawNotePattern, fitInstTopRow, fitRowControls, noteTint, renderInstrumentList,
                    setTrackRowHeight, setTrackZoom, sizeNameInput, syncWaveCustomOptions });
})();

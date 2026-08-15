/* Bit Beats — the advanced track editor's automation lane
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { selectedAutoPointIds, state } = BB;
const advTrack = (...a)=> BB.advTrack(...a), selectedTrack = (...a)=> BB.selectedTrack(...a),
      pushHistory = (...a)=> BB.pushHistory(...a), stepsPerBar = (...a)=> BB.stepsPerBar(...a),
      drawNotePattern = (...a)=> BB.drawNotePattern(...a), noteTint = (...a)=> BB.noteTint(...a),
      refreshInstrumentEditor = (...a)=> BB.refreshInstrumentEditor(...a),
      syncDockedPanels = (...a)=> BB.syncDockedPanels(...a);
/* ======================================================================
   ADVANCED TRACK EDITOR (AUTOMATION LANES)
   ====================================================================== */
BB.ADV_LANE_H = 160; // recalculated in renderAdvancedEditor from the lane card's actual measured height
const ADV_LANE_TOP = 22; // must match #advLaneCanvas's CSS top offset (the header's own height — canvas sits flush beneath it, no gap, so header+canvas read as one continuous shape)
const ADV_PARAM_LABELS = {volume:"Volume", pan:"Pan", reverb:"Reverb", eqLow:"EQ Low", eqMid:"EQ Mid", eqHigh:"EQ High"};

// the value (0-100) this parameter shows as a flat line until the user actually draws a curve for it —
// this is what keeps an empty lane in sync with the track's own sliders, per param, rather than a fixed default
function autoDefaultValue(track, param){
  switch(param){
    case "volume": return track.volume*100;
    case "pan": return track.pan;
    case "reverb": return track.instrument.reverb;
    case "eqLow": return (track.instrument.eqLow+24)/48*100;
    case "eqMid": return (track.instrument.eqMid+24)/48*100;
    case "eqHigh": return (track.instrument.eqHigh+24)/48*100;
    default: return 50;
  }
}

function renderAdvancedEditor(){
  const panel = document.getElementById("advancedEditor");
  // #rollDivider resizes THIS panel and nothing else, so while the editor is closed it is a draggable
  // strip that controls nothing, parked above the piano roll. It is driven from BOTH branches below off
  // the same condition as the panel itself, so the bar and the thing it drags can never disagree.
  const divider = document.getElementById("rollDivider");
  const track = advTrack();
  // both branches re-place the dock panels, because opening/closing this editor is exactly what decides
  // whether a registered panel floats or docks. It has to happen BEFORE the lane is measured below: a
  // panel docking into #advDockLeft takes width away from #advLaneScroll, and the canvas is sized from
  // that element's live clientWidth/clientHeight.
  if(!track){ panel.classList.add("hidden"); if(divider) divider.classList.add("hidden"); syncDockedPanels(); return; }
  panel.classList.remove("hidden");
  if(divider) divider.classList.remove("hidden");
  syncDockedPanels();

  document.querySelectorAll(".advTabBtn").forEach(b=> b.classList.toggle("active", b.dataset.param===state.advancedParam));

  const header = document.getElementById("advLaneHeader");
  header.textContent = track.name+" — "+ADV_PARAM_LABELS[state.advancedParam];
  header.style.background = track.color;

  const spb = stepsPerBar();
  // fill at least the visible scroll viewport (plus a little breathing room past it), so the lane's
  // colored backdrop reaches the right edge instead of stopping wherever the last bar happens to be
  const scrollEl = document.getElementById("advLaneScroll");
  const viewportW = scrollEl.clientWidth;
  const totalW = Math.max(1, BB.STEPS_TOTAL/spb*BB.BAR_PX, viewportW-40)+40;
  document.getElementById("advLaneInner").style.width = totalW+"px";
  header.style.width = totalW+"px";

  const laneW = totalW; // canvas now spans the full width, flush with the header above it — together they read as one continuous shape
  // measured fresh each render so the canvas always fits the card's real height (accounting for the horizontal scrollbar), never spilling past its bottom edge
  BB.ADV_LANE_H = Math.max(40, scrollEl.clientHeight - ADV_LANE_TOP);

  const canvas = document.getElementById("advLaneCanvas");
  const dpr = window.devicePixelRatio||1;
  canvas.width = laneW*dpr; canvas.height = BB.ADV_LANE_H*dpr;
  canvas.style.width = laneW+"px"; canvas.style.height = BB.ADV_LANE_H+"px";
  const ctx = canvas.getContext("2d"); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,laneW,BB.ADV_LANE_H);

  // solid track-colored backdrop, echoing the track block's own coloring (and the lane header above it)
  ctx.fillStyle = track.color; ctx.globalAlpha = 0.4; ctx.fillRect(0,0,laneW,BB.ADV_LANE_H); ctx.globalAlpha = 1;

  const points = track.automation[state.advancedParam].slice().sort((a,b)=>a.step-b.step);
  const valueToY = v=> BB.ADV_LANE_H-(v/100*BB.ADV_LANE_H);
  const stepToX = s=> s/spb*BB.BAR_PX;

  // ghost note tiles from the track's own notes, positioned by step/duration and pitch —
  // same idea as the mini note-pattern drawn inside the track list's blocks, so you can read the
  // notes against the automation curve
  if(track.notes.length){
    // The tiles get their OWN horizontal space rather than inheriting the timeline's: the track's note
    // span (earliest start → latest end) is stretched across the lane, inset on both sides, so the
    // pattern fills the rectangle comfortably no matter what BAR_PX is or how far into the project the
    // notes actually sit. Durations stay proportional within that mapping, so a note twice as long
    // still draws twice as wide.
    // Fitted to the VISIBLE rectangle, not the full canvas: laneW carries the lane's scrollable width
    // (STEPS_TOTAL at the current zoom, plus 40px of trailing breathing room), which is routinely wider
    // than the scroll viewport — mapping across it would park the tail of the pattern just off the right
    // edge, which is exactly the "doesn't fit in the rectangle" this mapping exists to fix. The whole
    // preview therefore reads at a glance with no horizontal scrolling.
    // The curve and its draggable dots deliberately stay in the real, unscaled stepToX space: the
    // advPointLayer drag handlers convert pixels back to steps via BAR_PX, so rescaling them here
    // would silently break that math. Only these decorative tiles are remapped.
    const INSET_H = 10;
    const fitW = Math.min(laneW, scrollEl.clientWidth || laneW);
    const innerW = Math.max(1, fitW - INSET_H*2);
    const spanStart = Math.min(...track.notes.map(n=>n.step));
    const spanEnd = Math.max(...track.notes.map(n=>n.step+n.dur));
    // a lone note (or any zero-width span) would otherwise divide by zero — one step is the smallest
    // span that still maps to a real width, and the minTileW:2 passed below keeps it visible
    const span = Math.max(1, spanEnd-spanStart);
    // padV keeps the tiles off the lane's own top/bottom edge, independent of the card's outer inset;
    // 6-16px is the tile-height clamp a full-size lane can afford (see drawNotePattern)
    drawNotePattern(ctx, track.notes, {
      h: BB.ADV_LANE_H, xOf: s=> INSET_H + (s-spanStart)/span*innerW,
      padV: 8, minTileH: 6, maxTileH: 16, minTileW: 2, gap: 1, tint: noteTint(track.color, 0.55)
    });
  }

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if(points.length===0){
    const y = valueToY(autoDefaultValue(track, state.advancedParam));
    ctx.moveTo(0,y); ctx.lineTo(laneW,y);
  } else {
    ctx.moveTo(0, valueToY(points[0].value));
    points.forEach(p=> ctx.lineTo(stepToX(p.step), valueToY(p.value)));
    ctx.lineTo(laneW, valueToY(points[points.length-1].value));
  }
  ctx.stroke();

  const layer = document.getElementById("advPointLayer");
  layer.innerHTML = "";
  points.forEach(p=>{
    const dot = document.createElement("div");
    dot.className = "autoPoint"+(selectedAutoPointIds.has(p.id)?" selected":"");
    dot.style.left = stepToX(p.step)+"px";
    dot.style.top = valueToY(p.value)+"px";
    dot.dataset.id = p.id;
    dot.title = Math.round(p.value)+"%";
    layer.appendChild(dot);
  });
}

BB.autoDrag = null; // {trackId, param, origin:[{id,step,value}], startStep, startValue}

document.getElementById("advTabs").addEventListener("click",(e)=>{
  const btn = e.target.closest(".advTabBtn"); if(!btn) return;
  state.advancedParam = btn.dataset.param;
  selectedAutoPointIds.clear();
  renderAdvancedEditor();
});
document.getElementById("advToggleBtn").addEventListener("click", ()=>{
  const t = selectedTrack(); if(!t) return;
  if(state.advancedTrackId===t.id){ state.advancedTrackId = null; }
  else { state.advancedTrackId = t.id; state.advancedParam = "volume"; selectedAutoPointIds.clear(); }
  refreshInstrumentEditor();
  renderAdvancedEditor();
});
document.getElementById("advCloseBtn").addEventListener("click", ()=>{
  state.advancedTrackId = null; selectedAutoPointIds.clear();
  refreshInstrumentEditor();
  renderAdvancedEditor();
});
// double-click empty lane space to drop a new automation point at that step/value
document.getElementById("advPointLayer").addEventListener("dblclick",(e)=>{
  if(e.target.classList.contains("autoPoint")) return;
  const track = advTrack(); if(!track) return;
  const rect = document.getElementById("advLaneCanvas").getBoundingClientRect();
  const spb = stepsPerBar();
  const step = Math.max(0, (e.clientX-rect.left)/BB.BAR_PX*spb);
  const value = Math.max(0, Math.min(100, 100-(e.clientY-rect.top)/BB.ADV_LANE_H*100));
  pushHistory();
  track.automation[state.advancedParam].push({id: BB.nextNoteId++, step, value});
  renderAdvancedEditor();
});
document.getElementById("advPointLayer").addEventListener("mousedown",(e)=>{
  const dot = e.target.closest(".autoPoint"); if(!dot) return;
  const track = advTrack(); if(!track) return;
  const id = Number(dot.dataset.id);
  if(e.shiftKey){
    // shift-click toggles this dot into/out of the multi-selection, without starting a drag
    if(selectedAutoPointIds.has(id)) selectedAutoPointIds.delete(id); else selectedAutoPointIds.add(id);
    renderAdvancedEditor();
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if(!selectedAutoPointIds.has(id)){ selectedAutoPointIds.clear(); selectedAutoPointIds.add(id); renderAdvancedEditor(); }
  pushHistory();
  const points = track.automation[state.advancedParam];
  const origin = points.filter(p=>selectedAutoPointIds.has(p.id)).map(p=>({id:p.id, step:p.step, value:p.value}));
  const rect = document.getElementById("advLaneCanvas").getBoundingClientRect();
  const spb = stepsPerBar();
  BB.autoDrag = {
    trackId: track.id, param: state.advancedParam, origin,
    startStep: (e.clientX-rect.left)/BB.BAR_PX*spb,
    startValue: 100-(e.clientY-rect.top)/BB.ADV_LANE_H*100
  };
  e.preventDefault(); e.stopPropagation();
});

/* exported to the shared namespace */
Object.assign(BB, { autoDefaultValue, renderAdvancedEditor });
})();

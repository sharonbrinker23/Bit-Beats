/* Bit Beats — play / pause, the lookahead scheduler, the playheads and the loop region
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { state, actx, gridScroll } = BB;
const anySolo = (...a)=> BB.anySolo(...a), applyInstrumentToChain = (...a)=> BB.applyInstrumentToChain(...a),
      liveTarget = (...a)=> BB.liveTarget(...a), noteVoice = (...a)=> BB.noteVoice(...a),
      playClick = (...a)=> BB.playClick(...a), playNote = (...a)=> BB.playNote(...a),
      silenceAllVoices = (...a)=> BB.silenceAllVoices(...a),
      applyAutomationAtStep = (...a)=> BB.applyAutomationAtStep(...a),
      beatsPerBar = (...a)=> BB.beatsPerBar(...a), stepsPerBar = (...a)=> BB.stepsPerBar(...a);
/* ======================================================================
   TRANSPORT / SCHEDULER
   ====================================================================== */
let schedulerTimer=null, playCtxStartTime=0, playStepAt0=0;
function stepDurSec(){ return (60/state.bpm) / 4; } // 16th-note step
function currentPlayStep(){
  if(!state.playing) return state.playStartStep;
  const elapsed = actx.currentTime - playCtxStartTime;
  return playStepAt0 + elapsed/stepDurSec();
}
let scheduledUpTo = 0;
let scheduledMetroUpTo = 0;
function startPlayback(){
  if(state.playing) return;
  if(actx.state==="suspended") actx.resume();
  // pressing play with an active loop should always land you inside it, not silently play through
  // from wherever the playhead happens to be sitting outside the loop's bounds
  if(state.loop.enabled && (state.playStartStep<state.loop.start || state.playStartStep>=state.loop.end)){
    state.playStartStep = state.loop.start;
  }
  state.playing = true;
  playCtxStartTime = actx.currentTime;
  playStepAt0 = state.playStartStep;
  scheduledUpTo = playStepAt0;
  scheduledMetroUpTo = playStepAt0;
  document.getElementById("playBtn").innerHTML = "&#10074;&#10074;";
  schedulerTimer = setInterval(schedulerTick, 25);
  schedulerTick();
  requestAnimationFrame(animatePlayhead);
}
function stopPlayback(resetHead){
  // must be read before state.playing flips to false — currentPlayStep() falls back to the
  // (stale) state.playStartStep once playing is false, which was silently discarding the paused
  // position and snapping the playhead back to wherever it last started from
  const pausedAtStep = currentPlayStep();
  state.playing = false;
  clearInterval(schedulerTimer);
  document.getElementById("playBtn").innerHTML = "&#9654;";
  state.playStartStep = resetHead ? 0 : pausedAtStep;
  silenceAllVoices();
  // automation only drives the chain during playback; once stopped, drop each track back to its own knob values
  state.tracks.forEach(applyInstrumentToChain);
  renderPlayheads();
}
// the Play button's own play/pause toggle — whether pausing keeps the playhead where it paused or
// snaps it back to the start is governed by the "Hold" button (off by default: snaps back)
function togglePlayPause(){
  if(state.playing) stopPlayback(!state.holdPositionOnPause);
  else startPlayback();
}
function schedulerTick(){
  const lookahead = 0.12; // seconds
  let nowStep = currentPlayStep();
  if(state.loop.enabled && nowStep >= state.loop.end){
    playCtxStartTime = actx.currentTime;
    playStepAt0 = state.loop.start;
    scheduledUpTo = playStepAt0;
    scheduledMetroUpTo = playStepAt0;
    nowStep = playStepAt0;
  }
  applyAutomationAtStep(nowStep);
  const horizon = nowStep + lookahead/stepDurSec();
  if(state.metronomeOn){
    const spb = stepsPerBar();
    const beatStep = spb/beatsPerBar();
    let s = Math.ceil(scheduledMetroUpTo/beatStep)*beatStep;
    for(; s < horizon; s += beatStep){
      const t = playCtxStartTime + (s - playStepAt0)*stepDurSec();
      if(t >= actx.currentTime-0.01){
        // s is always a multiple of beatStep measured from absolute step 0, so this lines up with the
        // same bar grid the ruler/arrange view uses regardless of where playback happened to start
        playClick(t, Math.round(s) % spb === 0);
      }
    }
    scheduledMetroUpTo = horizon;
  }
  state.tracks.forEach(track=>{
    const solo = anySolo();
    const audible = solo ? track.solo : !track.muted;
    if(!audible) return;
    track.notes.forEach(note=>{
      if(note.step >= scheduledUpTo && note.step < horizon){
        const t = playCtxStartTime + (note.step - playStepAt0)*stepDurSec();
        if(t >= actx.currentTime-0.01){
          playNote(track, noteVoice(note, t), liveTarget(track));
        }
      }
    });
  });
  scheduledUpTo = horizon;
  if(!state.loop.enabled && nowStep > BB.STEPS_TOTAL) stopPlayback(true);
}
function animatePlayhead(){
  if(!state.playing) return;
  renderPlayheads();
  requestAnimationFrame(animatePlayhead);
}
function renderPlayheads(){
  const step = currentPlayStep();
  const x = step*BB.STEP_W;
  document.getElementById("playhead").style.left = x+"px";
  // the grip is a sticky sibling (not JS-positioned vertically — see its CSS), so it only needs its
  // horizontal offset kept in sync with the playhead line; its "stuck" vertical tracking of the ruler
  // is handled natively by the browser's compositor, with zero lag versus a scroll-event handler.
  // Positioned via transform, not left: a sticky element sticks whichever axis has a non-auto inset,
  // so setting `left` here would also freeze the grip horizontally once the grid scrolled underneath it.
  document.getElementById("playheadGrip").style.transform = "translateX("+x+"px)";
  const trackX = step/stepsPerBar()*BB.BAR_PX;
  document.getElementById("trackListPlayhead").style.left = trackX+"px";
  positionTrackListFlag();
  // Follow the playhead only while it is actually moving under playback's control. When stopped, the
  // two scrollers belong entirely to the user — renderPlayheads() also runs on zoom, undo, edits and
  // manual playhead drags, and yanking the view on any of those would be hostile.
  if(state.playing){
    centerScrollOnPlayhead(gridScroll, x);
    centerScrollOnPlayhead(document.getElementById("trackListCol"), trackX);
  }
}
// Parks `x` (a content-space pixel offset) in the middle of the scroller's viewport, clamped to the
// real scroll range so the very start and very end of the project simply sit off-center instead of
// being forced past the ends. scrollLeft ONLY: the arrange view mirrors scrollTop between
// #instrumentListScroll and #trackListCol, so touching the vertical axis here would fight that sync.
// Writing scrollLeft does fire each element's "scroll" listener, but neither one reads scrollLeft
// (syncPianoScroll only mirrors scrollTop to the piano column), so there is no feedback loop.
function centerScrollOnPlayhead(el, x){
  if(!el) return;
  const max = el.scrollWidth - el.clientWidth;
  if(max <= 0) return; // content fits: nothing to scroll, and scrollLeft would just clamp to 0 anyway
  el.scrollLeft = Math.max(0, Math.min(max, x - el.clientWidth/2));
}

// keeps the little playhead flag pinned to whatever row is currently scrolled to the top of the
// arrange view (like the ruler), instead of staying anchored to the top of the full scrollable content
function positionTrackListFlag(){
  const flag = document.getElementById("trackListPlayheadFlag");
  const tc = document.getElementById("trackListCol");
  if(!flag || !tc) return;
  const step = currentPlayStep();
  flag.style.left = (step/stepsPerBar()*BB.BAR_PX - 6) + "px";
  flag.style.top = tc.scrollTop + "px";
}

/* ======================================================================
   LOOP REGION
   ====================================================================== */
function renderLoopUI(){
  const region = document.getElementById("loopRegion");
  if(!region) return;
  const spb = stepsPerBar();
  region.style.display = "block";
  region.style.left = (state.loop.start/spb*BB.BAR_PX)+"px";
  region.style.width = Math.max(4,(state.loop.end-state.loop.start)/spb*BB.BAR_PX)+"px";
  region.classList.toggle("enabled", state.loop.enabled);
}

/* exported to the shared namespace */
Object.assign(BB, { currentPlayStep, positionTrackListFlag, renderLoopUI, renderPlayheads, stepDurSec,
                    stopPlayback, togglePlayPause });
})();

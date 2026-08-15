/* Bit Beats — automation lanes -> live audio parameters
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { state, actx } = BB;
const anySolo = (...a)=> BB.anySolo(...a), buildChain = (...a)=> BB.buildChain(...a),
      autoDefaultValue = (...a)=> BB.autoDefaultValue(...a);
/* ======================================================================
   AUTOMATION LANES -> LIVE AUDIO PARAMETERS
   each lane (Volume/Pan/Reverb/EQ Low/EQ Mid/EQ High) is a set of 0-100 points
   plotted step->value; while a lane has no points drawn, its parameter just
   tracks the track's own knob (see autoDefaultValue), so automation only takes
   over once the user actually draws a curve for it
   ====================================================================== */
function automationValueAt(track, param, step){
  const points = track.automation[param];
  if(!points || points.length===0) return autoDefaultValue(track, param);
  const pts = points.slice().sort((a,b)=>a.step-b.step);
  if(step<=pts[0].step) return pts[0].value;
  if(step>=pts[pts.length-1].step) return pts[pts.length-1].value;
  for(let i=0;i<pts.length-1;i++){
    const a=pts[i], b=pts[i+1];
    if(step>=a.step && step<=b.step){
      const f = (step-a.step)/((b.step-a.step)||1);
      return a.value + (b.value-a.value)*f;
    }
  }
  return pts[pts.length-1].value;
}
// smoothing time constant for setTargetAtTime: short enough to track the drawn curve responsively,
// long enough (paired with the 25ms scheduler tick) to avoid zipper-noise clicks between updates
const AUTOMATION_SMOOTHING = 0.02;
function applyAutomationAtStep(step){
  const solo = anySolo();
  const now = actx.currentTime;
  state.tracks.forEach(track=>{
    if(!track._chain) buildChain(track);
    const c = track._chain;
    const audible = solo ? track.solo : !track.muted;
    const vol = automationValueAt(track,"volume",step)/100;
    const pan = Math.max(-1, Math.min(1, (automationValueAt(track,"pan",step)-50)/50));
    const reverb = automationValueAt(track,"reverb",step)/100;
    const eqLow = automationValueAt(track,"eqLow",step)/100*48-24;
    const eqMid = automationValueAt(track,"eqMid",step)/100*48-24;
    const eqHigh = automationValueAt(track,"eqHigh",step)/100*48-24;
    c.trackOut.gain.setTargetAtTime(audible?vol:0, now, AUTOMATION_SMOOTHING);
    c.panNode.pan.setTargetAtTime(pan, now, AUTOMATION_SMOOTHING);
    c.eqLow.gain.setTargetAtTime(eqLow, now, AUTOMATION_SMOOTHING);
    c.eqMid.gain.setTargetAtTime(eqMid, now, AUTOMATION_SMOOTHING);
    c.eqHigh.gain.setTargetAtTime(eqHigh, now, AUTOMATION_SMOOTHING);
    c.dry.gain.setTargetAtTime(1-reverb*0.6, now, AUTOMATION_SMOOTHING);
    c.wet.gain.setTargetAtTime(reverb, now, AUTOMATION_SMOOTHING);
  });
}

function refreshAllTrackGains(){
  const solo = anySolo();
  state.tracks.forEach(t=>{
    if(!t._chain) buildChain(t);
    const audible = solo ? t.solo : !t.muted;
    t._chain.trackOut.gain.value = audible ? t.volume : 0;
  });
}

/* exported to the shared namespace */
Object.assign(BB, { applyAutomationAtStep, automationValueAt, refreshAllTrackGains });
})();

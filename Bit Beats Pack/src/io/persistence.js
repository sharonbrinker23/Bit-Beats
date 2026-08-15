/* Bit Beats — save / load / new, and the WAV, MP3, MIDI and JSON export formats
   Classic script (no modules): see ARCHITECTURE.md for the load order. */
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
/* collaborators, read from the shared namespace. Plain values are read once (the file that defines
   them has already run); functions are one-line forwarders so a file may call one that a script
   further down the load order defines. Nothing here touches `window` except BitBeats itself. */
const { STEPS_TOTAL_BASE, selectedAutoPointIds, state, actx, masterGain, TOP_MIDI, TOTAL_ROWS } = BB;
const anySolo = (...a)=> BB.anySolo(...a), defaultAutomation = (...a)=> BB.defaultAutomation(...a),
      defaultInstrument = (...a)=> BB.defaultInstrument(...a), makeTrack = (...a)=> BB.makeTrack(...a),
      resolveTrackSample = (...a)=> BB.resolveTrackSample(...a),
      cloneAutomation = (...a)=> BB.cloneAutomation(...a), dropCheckpoint = (...a)=> BB.dropCheckpoint(...a),
      pushHistory = (...a)=> BB.pushHistory(...a), resetHistory = (...a)=> BB.resetHistory(...a),
      buildChain = (...a)=> BB.buildChain(...a), makeChain = (...a)=> BB.makeChain(...a),
      noteVoice = (...a)=> BB.noteVoice(...a), playNote = (...a)=> BB.playNote(...a),
      renderTarget = (...a)=> BB.renderTarget(...a), automationValueAt = (...a)=> BB.automationValueAt(...a),
      buildPianoLabels = (...a)=> BB.buildPianoLabels(...a), drawGridLines = (...a)=> BB.drawGridLines(...a),
      extendRegionsForNote = (...a)=> BB.extendRegionsForNote(...a),
      recomputeStepsTotal = (...a)=> BB.recomputeStepsTotal(...a), renderNotes = (...a)=> BB.renderNotes(...a),
      sizeGrid = (...a)=> BB.sizeGrid(...a), stepsPerBar = (...a)=> BB.stepsPerBar(...a),
      stepDurSec = (...a)=> BB.stepDurSec(...a), stopPlayback = (...a)=> BB.stopPlayback(...a),
      buildTrackList = (...a)=> BB.buildTrackList(...a),
      renderInstrumentList = (...a)=> BB.renderInstrumentList(...a),
      renderAdvancedEditor = (...a)=> BB.renderAdvancedEditor(...a),
      refreshInstrumentEditor = (...a)=> BB.refreshInstrumentEditor(...a),
      renderProjectTitle = (...a)=> BB.renderProjectTitle(...a),
      renderChordPalette = (...a)=> BB.renderChordPalette(...a),
      renderSamplePanel = (...a)=> BB.renderSamplePanel(...a),
      stopSamplePreview = (...a)=> BB.stopSamplePreview(...a), toast = (...a)=> BB.toast(...a),
      initDefaultProject = (...a)=> BB.initDefaultProject(...a);
/* ======================================================================
   SAVE / LOAD / NEW
   ====================================================================== */
function serializeProject(){
  return {
    projectTitle: state.projectTitle, bpm: state.bpm, timeSig: state.timeSig, key: state.key, mode: state.mode,
    octaveFocus: state.octaveFocus, noteLenSteps: state.noteLenSteps,
    tracks: state.tracks.map(t=>({
      id:t.id, name:t.name, color:t.color, muted:t.muted, solo:t.solo, volume:t.volume, pan:t.pan,
      instrument: { wave:t.instrument.wave, volume:t.instrument.volume, attack:t.instrument.attack,
        release:t.instrument.release, eqLow:t.instrument.eqLow, eqMid:t.instrument.eqMid,
        eqHigh:t.instrument.eqHigh, reverb:t.instrument.reverb, customBaseMidi:t.instrument.customBaseMidi,
        // the id only, never the buffer: a decoded AudioBuffer is not JSON, and shipping raw audio
        // inside a project file is out of scope. Re-opening the file in the SAME session still finds
        // its sample (the registry is alive); in a fresh one the id resolves to nothing and the track
        // falls back to the generic "Custom" option, which is what it did before samples had names.
        sampleId:t.instrument.sampleId??null },
      notes: t.notes.map(n=>({id:n.id, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null, bendStartStep:n.bendStartStep??0, bendEndStep:n.bendEndStep??null})),
      regions: t.regions ? t.regions.map(r=>({id:r.id, start:r.start, end:r.end})) : null,
      automation: cloneAutomation(t.automation)
    }))
  };
}
/* ---- export: WAV (offline render of the whole project) ---- */
function audioBufferToWavBlob(buffer){
  const numCh = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const blockAlign = numCh*2, dataSize = len*blockAlign;
  const ab = new ArrayBuffer(44+dataSize);
  const view = new DataView(ab);
  const writeStr = (offset,str)=>{ for(let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); };
  writeStr(0,"RIFF"); view.setUint32(4,36+dataSize,true); writeStr(8,"WAVE");
  writeStr(12,"fmt "); view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,numCh,true); view.setUint32(24,sr,true);
  view.setUint32(28,sr*blockAlign,true); view.setUint16(32,blockAlign,true); view.setUint16(34,16,true);
  writeStr(36,"data"); view.setUint32(40,dataSize,true);
  const channels = []; for(let c=0;c<numCh;c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for(let i=0;i<len;i++){
    for(let c=0;c<numCh;c++){
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s<0 ? s*0x8000 : s*0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([ab], {type:"audio/wav"});
}
// renders the whole project offline into a raw AudioBuffer — shared by both the WAV and MP3 export
// paths, which just encode this same buffer two different ways
// `loopCount` (default 1) renders the project back-to-back that many times. It is deliberately done
// by scheduling every note again on each pass inside ONE offline render — rather than rendering once
// and concatenating the resulting buffer — so a note's release and its reverb tail bleed across each
// seam exactly as they would in live playback. Concatenating a buffer that already contains a tail
// would duplicate that tail and leave an audible bump at every repeat.
// The repeat period is the project length rounded UP to a whole bar, so each pass starts on the beat.
async function renderProjectToAudioBuffer(loopCount){
  const repeats = Math.max(1, Math.floor(Number(loopCount)||1));
  let lastStep = stepsPerBar();
  state.tracks.forEach(t=> t.notes.forEach(n=> lastStep = Math.max(lastStep, n.step+n.dur)));
  const spb = stepsPerBar();
  const loopLenSteps = Math.max(spb, Math.ceil(lastStep/spb)*spb);
  const loopSec = loopLenSteps*stepDurSec();
  const tailSec = 1.0; // let releases/reverb ring out past the last note
  const durSec = repeats*loopSec + tailSec;
  const sr = actx.sampleRate;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(durSec*sr), sr);
  const offlineMaster = offlineCtx.createGain(); offlineMaster.gain.value = masterGain.gain.value;
  offlineMaster.connect(offlineCtx.destination);
  // reverb/noise buffers must belong to offlineCtx — buffers created against the live actx can't be
  // reused in an OfflineAudioContext's graph, so these are regenerated the same way makeReverbBuffer/
  // getNoiseBuffer do it for the live context
  const reverbBuf = (()=>{
    const rate = offlineCtx.sampleRate, rlen = rate*2.2, buf = offlineCtx.createBuffer(2,rlen,rate);
    for(let ch=0; ch<2; ch++){ const d = buf.getChannelData(ch);
      for(let i=0;i<rlen;i++){ d[i] = (Math.random()*2-1) * Math.pow(1-i/rlen, 2.5); } }
    return buf;
  })();
  const noiseBuf = (()=>{
    const len = offlineCtx.sampleRate, buf = offlineCtx.createBuffer(1,len,offlineCtx.sampleRate);
    const d = buf.getChannelData(0); for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
    return buf;
  })();
  const solo = anySolo();
  state.tracks.forEach(track=>{
    const chain = makeChain(offlineCtx, reverbBuf, offlineMaster);
    const audible = solo ? track.solo : !track.muted;
    const hasAutomation = Object.values(track.automation).some(arr=>arr && arr.length);
    if(!hasAutomation){
      chain.eqLow.gain.value = track.instrument.eqLow;
      chain.eqMid.gain.value = track.instrument.eqMid;
      chain.eqHigh.gain.value = track.instrument.eqHigh;
      const wetAmt = track.instrument.reverb/100;
      chain.dry.gain.value = 1-wetAmt*0.6; chain.wet.gain.value = wetAmt;
      chain.trackOut.gain.value = audible ? track.volume : 0;
      chain.panNode.pan.value = (track.pan-50)/50;
    } else {
      // automation moves parameters over time, so sample the drawn curves at a fixed rate across the
      // whole render and schedule them, mirroring what applyAutomationAtStep does tick-by-tick live
      const dt = 0.1;
      for(let t=0; t<=durSec; t+=dt){
        // automation replays from the top on every repeat, same as the notes do
        const step = (t % loopSec)/stepDurSec();
        const vol = automationValueAt(track,"volume",step)/100;
        const pan = Math.max(-1, Math.min(1, (automationValueAt(track,"pan",step)-50)/50));
        const reverb = automationValueAt(track,"reverb",step)/100;
        chain.trackOut.gain.setValueAtTime(audible?vol:0, t);
        chain.panNode.pan.setValueAtTime(pan, t);
        chain.eqLow.gain.setValueAtTime(automationValueAt(track,"eqLow",step)/100*48-24, t);
        chain.eqMid.gain.setValueAtTime(automationValueAt(track,"eqMid",step)/100*48-24, t);
        chain.eqHigh.gain.setValueAtTime(automationValueAt(track,"eqHigh",step)/100*48-24, t);
        chain.dry.gain.setValueAtTime(1-reverb*0.6, t);
        chain.wet.gain.setValueAtTime(reverb, t);
      }
    }
    if(!audible) return;
    for(let pass=0; pass<repeats; pass++){
      const passOffset = pass*loopSec;
      track.notes.forEach(note=>{
        const startTime = passOffset + note.step*stepDurSec();
        playNote(track, noteVoice(note, startTime), renderTarget(offlineCtx, chain, noiseBuf));
      });
    }
  });
  return offlineCtx.startRendering();
}
async function renderProjectToWavBlob(loopCount){
  return audioBufferToWavBlob(await renderProjectToAudioBuffer(loopCount));
}

/* ---- export: MP3 (via bundled lamejs — see lamejs.min.js) ---- */
function audioBufferToMp3Blob(buffer){
  const numCh = Math.min(2, buffer.numberOfChannels);
  const encoder = new lamejs.Mp3Encoder(numCh, buffer.sampleRate, 160);
  const toInt16 = (channelData)=>{
    const out = new Int16Array(channelData.length);
    for(let i=0;i<channelData.length;i++){
      const s = Math.max(-1, Math.min(1, channelData[i]));
      out[i] = s<0 ? s*0x8000 : s*0x7FFF;
    }
    return out;
  };
  const left = toInt16(buffer.getChannelData(0));
  const right = numCh>1 ? toInt16(buffer.getChannelData(1)) : null;
  const blockSize = 1152; // lamejs encodes one MPEG frame's worth of samples per call
  const chunks = [];
  for(let i=0; i<left.length; i+=blockSize){
    const chunk = numCh>1
      ? encoder.encodeBuffer(left.subarray(i,i+blockSize), right.subarray(i,i+blockSize))
      : encoder.encodeBuffer(left.subarray(i,i+blockSize));
    if(chunk.length) chunks.push(chunk);
  }
  const finalChunk = encoder.flush();
  if(finalChunk.length) chunks.push(finalChunk);
  return new Blob(chunks, {type:"audio/mpeg"});
}
async function renderProjectToMp3Blob(loopCount){
  return audioBufferToMp3Blob(await renderProjectToAudioBuffer(loopCount));
}

/* ---- export: Standard MIDI File (format 1) ---- */
function midiVarLen(value){
  const bytes = [value & 0x7F];
  value = Math.floor(value/128);
  while(value>0){ bytes.unshift((value & 0x7F) | 0x80); value = Math.floor(value/128); }
  return bytes;
}
function midiTrackChunk(eventBytes){
  const len = eventBytes.length;
  return [0x4D,0x54,0x72,0x6B, (len>>>24)&0xFF,(len>>>16)&0xFF,(len>>>8)&0xFF,len&0xFF, ...eventBytes];
}
// rough General MIDI program per waveform, just so a MIDI player picks *some* reasonable timbre
function gmProgramForWave(wave){
  return {square:80, pulse25:80, pulse12:80, sawtooth:81, triangle:73, sine:89, custom:0}[wave] ?? 0;
}
function projectToMidiBytes(){
  const PPQ = 480, ticksPerStep = PPQ/4; // steps are always 16th notes
  const ntracks = state.tracks.length+1;
  const header = [0x4D,0x54,0x68,0x64, 0,0,0,6, 0,1, (ntracks>>8)&0xFF,ntracks&0xFF, (PPQ>>8)&0xFF, PPQ&0xFF];
  const conductorEvents = [];
  const usPerQuarter = Math.round(60000000/state.bpm);
  conductorEvents.push(...midiVarLen(0), 0xFF,0x51,0x03, (usPerQuarter>>16)&0xFF,(usPerQuarter>>8)&0xFF,usPerQuarter&0xFF);
  const denomPow2 = Math.round(Math.log2(state.timeSig[1]));
  conductorEvents.push(...midiVarLen(0), 0xFF,0x58,0x04, state.timeSig[0], denomPow2, 24, 8);
  conductorEvents.push(...midiVarLen(0), 0xFF,0x2F,0x00);
  const chunks = [midiTrackChunk(conductorEvents)];
  state.tracks.forEach((track,idx)=>{
    const channel = track.instrument.wave==="noise" ? 9 : (idx%15 >= 9 ? idx%15+1 : idx%15); // dodge ch.10 (drums) for melodic tracks
    const events = [];
    const nameBytes = Array.from(track.name).map(c=>c.charCodeAt(0)).slice(0,40);
    events.push(...midiVarLen(0), 0xFF,0x03, nameBytes.length, ...nameBytes);
    events.push(...midiVarLen(0), 0xC0|channel, gmProgramForWave(track.instrument.wave));
    const noteEvents = [];
    track.notes.forEach(n=>{
      const onTick = Math.round(n.step*ticksPerStep);
      const offTick = Math.round((n.step+n.dur)*ticksPerStep);
      const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
      noteEvents.push({tick:onTick, bytes:[0x90|channel, pitch, 100]});
      noteEvents.push({tick:Math.max(onTick+1,offTick), bytes:[0x80|channel, pitch, 0]});
    });
    noteEvents.sort((a,b)=> a.tick-b.tick);
    let prevTick = 0;
    noteEvents.forEach(ev=>{
      events.push(...midiVarLen(ev.tick-prevTick), ...ev.bytes);
      prevTick = ev.tick;
    });
    events.push(...midiVarLen(0), 0xFF,0x2F,0x00);
    chunks.push(midiTrackChunk(events));
  });
  const bytes = [].concat(header, ...chunks);
  return new Uint8Array(bytes);
}

/* ---- import: Standard MIDI File (.mid/.midi) — the inverse of projectToMidiBytes above ---- */
function midiReadVarLen(bytes, pos){
  let value = 0, byte;
  do{ byte = bytes[pos++]; value = (value<<7) | (byte & 0x7F); } while(byte & 0x80);
  return {value, pos};
}
function parseMidiFile(arrayBuffer){
  const bytes = new Uint8Array(arrayBuffer);
  let pos = 0;
  function readStr(len){ let s=""; for(let i=0;i<len;i++) s+=String.fromCharCode(bytes[pos++]); return s; }
  function readU32(){ const v=(bytes[pos]<<24)|(bytes[pos+1]<<16)|(bytes[pos+2]<<8)|bytes[pos+3]; pos+=4; return v>>>0; }
  function readU16(){ const v=(bytes[pos]<<8)|bytes[pos+1]; pos+=2; return v; }
  if(readStr(4)!=="MThd") throw new Error("not a MIDI file");
  const hdrLen = readU32();
  readU16(); // format — not needed, format 0/1 both handled the same by just reading every MTrk chunk
  const ntrks = readU16();
  const division = readU16();
  pos += Math.max(0, hdrLen-6); // header is normally exactly 6 bytes, but skip forward if a file pads it
  if(division & 0x8000) throw new Error("SMPTE-based MIDI timing isn't supported");
  const ticksPerStep = division/4; // steps are always 16th notes — same convention projectToMidiBytes uses

  const tracks = [];
  let tempoUsPerQuarter = 500000; // default 120bpm, overwritten if the file sets a tempo meta event
  let timeSigNum = 4, timeSigDenPow = 2;

  for(let t=0; t<ntrks && pos<bytes.length; t++){
    if(readStr(4)!=="MTrk") break;
    const chunkLen = readU32();
    const chunkEnd = pos+chunkLen;
    let tick = 0, runningStatus = 0, trackName = null;
    const activeNotes = new Map(); // pitch -> tick note-on happened, so a later note-off can compute duration
    const noteEvents = [];
    while(pos<chunkEnd){
      const dt = midiReadVarLen(bytes,pos); pos = dt.pos; tick += dt.value;
      let statusByte = bytes[pos];
      if(statusByte & 0x80){ runningStatus = statusByte; pos++; } else { statusByte = runningStatus; }
      if(statusByte===0xFF){
        const metaType = bytes[pos++];
        const len = midiReadVarLen(bytes,pos); pos = len.pos;
        if(metaType===0x03){ const name = readStr(len.value); if(trackName==null) trackName = name; }
        else if(metaType===0x51 && len.value===3){ tempoUsPerQuarter = (bytes[pos]<<16)|(bytes[pos+1]<<8)|bytes[pos+2]; pos+=len.value; }
        else if(metaType===0x58 && len.value>=2){ timeSigNum = bytes[pos]; timeSigDenPow = bytes[pos+1]; pos+=len.value; }
        else pos += len.value;
      } else if(statusByte===0xF0 || statusByte===0xF7){
        const len = midiReadVarLen(bytes,pos); pos = len.pos; pos += len.value;
      } else {
        const type = statusByte & 0xF0;
        if(type===0x90 || type===0x80){
          const pitch = bytes[pos++], vel = bytes[pos++];
          if(type===0x90 && vel>0){
            activeNotes.set(pitch, tick);
          } else {
            const startTick = activeNotes.get(pitch);
            if(startTick!=null){ activeNotes.delete(pitch); noteEvents.push({startTick, endTick:tick, pitch}); }
          }
        } else if(type===0xC0 || type===0xD0){ pos += 1; }
        else { pos += 2; }
      }
    }
    pos = chunkEnd;
    if(noteEvents.length) tracks.push({name: trackName || ("Track "+(t+1)), noteEvents});
  }
  const bpm = Math.round(60000000/tempoUsPerQuarter);
  return {ticksPerStep, tracks, bpm, timeSig:[timeSigNum, Math.pow(2,timeSigDenPow)]};
}
// imports parsed MIDI tracks by appending them to the current project (like addTrack/paste-track),
// so it composes with undo history rather than replacing the project the way loadProject does
function importMidiTracks(parsed){
  if(!parsed.tracks.length){ toast("No note data found in that MIDI file"); return; }
  pushHistory();
  const startColorIdx = state.tracks.length;
  let imported = 0;
  parsed.tracks.forEach((mt, i)=>{
    const t = makeTrack(mt.name, startColorIdx+i);
    buildChain(t);
    mt.noteEvents.forEach(ne=>{
      const stepStart = Math.round(ne.startTick/parsed.ticksPerStep);
      const stepEnd = ne.endTick/parsed.ticksPerStep;
      const dur = Math.max(1, Math.round(stepEnd-stepStart));
      // clamp into the app's representable pitch range (matches rowToMidi/TOP_MIDI/TOTAL_ROWS)
      const pitch = Math.max(TOP_MIDI-TOTAL_ROWS+1, Math.min(TOP_MIDI, ne.pitch));
      const note = {id: BB.nextNoteId++, step:stepStart, pitch, dur, bendTo:null};
      t.notes.push(note);
      extendRegionsForNote(t, note);
    });
    if(t.notes.length){ state.tracks.push(t); imported++; }
  });
  if(!imported){ dropCheckpoint(); toast("No note data found in that MIDI file"); return; }
  if(parsed.bpm>=30 && parsed.bpm<=300){
    state.bpm = parsed.bpm;
    document.getElementById("bpmInput").value = state.bpm;
  }
  state.selectedTrackId = state.tracks[state.tracks.length-1].id;
  renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); buildTrackList(); recomputeStepsTotal();
  toast("Imported "+imported+" track"+(imported===1?"":"s")+" from MIDI");
}

/* ---- Save modal: title + filetype, native "save as" picker when available ---- */
// One entry per savable format, keyed by the value #exportTypeSel carries. ext / mime / desc describe
// the file; `loopable` says whether "repeat project" means anything for it (only a rendered PERFORMANCE
// can actually be repeated); build() produces the Blob and owns whatever progress text that takes.
// A new format is one more entry here — the Save handler below never grows another branch.
const exportTypeInfo = {
  mp3: {ext:"mp3", mime:"audio/mpeg", desc:"Audio", loopable:true,
    build:(info, loopCount, status)=>{
      status(loopCount>1 ? "Rendering audio ("+loopCount+" repeats)…" : "Rendering audio…");
      return renderProjectToMp3Blob(loopCount);
    }},
  wav: {ext:"wav", mime:"audio/wav", desc:"Audio", loopable:true,
    build:(info, loopCount, status)=>{
      status(loopCount>1 ? "Rendering audio ("+loopCount+" repeats)…" : "Rendering audio…");
      return renderProjectToWavBlob(loopCount);
    }},
  mid: {ext:"mid", mime:"audio/midi", desc:"MIDI", loopable:false,
    build:(info, loopCount, status)=>{
      status("Writing MIDI…");
      return new Blob([projectToMidiBytes()], {type:info.mime});
    }},
  json:{ext:"json", mime:"application/json", desc:"Project", loopable:false,
    build:(info)=> new Blob([JSON.stringify(serializeProject(), null, 1)], {type:info.mime})}
};
async function saveBlobToDisk(blob, suggestedName, mime){
  if(window.showSaveFilePicker){
    try{
      const ext = suggestedName.slice(suggestedName.lastIndexOf("."));
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types:[{description:mime, accept:{[mime]:[ext]}}]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    }catch(err){
      if(err && err.name==="AbortError") return false; // user cancelled the picker — don't also fall back
      // fall through to the download fallback for any other failure (e.g. API unsupported despite the feature check)
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = suggestedName; a.click();
  return true;
}
/* ---- small modal used to tell the user something before continuing (resolves when acknowledged) ---- */
function showInfoDialog(title, body){
  return new Promise(resolve=>{
    const modal = document.getElementById("infoModal");
    document.getElementById("infoTitle").textContent = title;
    document.getElementById("infoBody").textContent = body;
    modal.classList.remove("hidden");
    const ok = document.getElementById("infoOkBtn");
    const done = ()=>{ ok.removeEventListener("click", done); modal.classList.add("hidden"); resolve(); };
    ok.addEventListener("click", done);
    ok.focus();
  });
}
// the loop count only means anything while looping is switched on
function syncExportLoopUI(){
  const on = document.getElementById("exportLoopChk").checked;
  document.getElementById("exportLoopCount").disabled = !on;
}
document.getElementById("exportLoopChk").addEventListener("change", syncExportLoopUI);
document.getElementById("saveBtn").addEventListener("click", ()=>{
  // prefilled from the sub-header's project title, but still freely editable here
  document.getElementById("exportTitleInput").value = state.projectTitle || "Bit Beats Project";
  document.getElementById("exportStatus").textContent = "";
  syncExportLoopUI();
  document.getElementById("exportModal").classList.remove("hidden");
  document.getElementById("exportTitleInput").focus();
});
document.getElementById("exportCancelBtn").addEventListener("click", ()=>{
  document.getElementById("exportModal").classList.add("hidden");
});
document.getElementById("exportConfirmBtn").addEventListener("click", async ()=>{
  const titleInput = document.getElementById("exportTitleInput");
  const title = titleInput.value.trim() || "Bit Beats Project";
  state.projectTitle = title;
  renderProjectTitle();
  const type = document.getElementById("exportTypeSel").value;
  const info = exportTypeInfo[type];
  const statusEl = document.getElementById("exportStatus");
  const confirmBtn = document.getElementById("exportConfirmBtn");
  const loopOn = document.getElementById("exportLoopChk").checked;
  const loopCount = loopOn
    ? Math.max(2, Math.min(64, Math.round(Number(document.getElementById("exportLoopCount").value)||2)))
    : 1;
  // MIDI and JSON describe the project itself, not a rendered performance, so there is nothing to
  // repeat in the file — say so, then continue with a normal single-pass export once acknowledged
  if(loopOn && !info.loopable){
    await showInfoDialog("Looping doesn't apply to ."+info.ext+" files",
      "Repeats only affect rendered audio (MP3 / WAV). A ."+info.ext+" file stores the project itself, "+
      "so it will be saved once through — you can still repeat it in whatever plays or opens it. "+
      "Saving a single pass now.");
  }
  confirmBtn.disabled = true;
  try{
    const blob = await info.build(info, loopCount, (msg)=>{ statusEl.textContent = msg; });
    await saveBlobToDisk(blob, title+"."+info.ext, info.mime);
    document.getElementById("exportModal").classList.add("hidden");
    toast(info.desc+" saved");
  }catch(err){
    statusEl.textContent = "Save failed: "+(err && err.message ? err.message : "unknown error");
  }finally{
    confirmBtn.disabled = false;
  }
});
document.getElementById("loadBtn").addEventListener("click", ()=> document.getElementById("loadInput").click());
document.getElementById("loadInput").addEventListener("change",(e)=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  if(/\.midi?$/i.test(file.name)){
    reader.onload = ()=>{
      try{ importMidiTracks(parseMidiFile(reader.result)); }
      catch(err){ toast("Could not read MIDI file: "+(err && err.message ? err.message : "unknown error")); }
    };
    reader.readAsArrayBuffer(file);
  } else {
    reader.onload = ()=>{
      try{
        const data = JSON.parse(reader.result);
        loadProject(data);
        toast("Project loaded");
      }catch(err){ toast("Invalid project file"); }
    };
    reader.readAsText(file);
  }
  e.target.value="";
});
function loadProject(data){
  BB.STEPS_TOTAL = STEPS_TOTAL_BASE;
  state.projectTitle = data.projectTitle || "Bit Beats Project";
  state.bpm=data.bpm||120; state.timeSig=data.timeSig||[4,4]; state.key=data.key||"C"; state.mode=data.mode||"Major";
  state.octaveFocus=data.octaveFocus||4; state.noteLenSteps=data.noteLenSteps||4;
  document.getElementById("bpmInput").value=state.bpm;
  document.getElementById("timeSigSel").value=state.timeSig.join("/");
  document.getElementById("keySel").value=state.key; document.getElementById("modeSel").value=state.mode;
  document.getElementById("octaveSel").value=state.octaveFocus;
  document.getElementById("noteLenSel").value=state.noteLenSteps;
  // assigning .value never fires "change", so the chord palette's key/mode labels would still be
  // showing the OUTGOING project's scale degrees until the user touched one of those two selects.
  // That same silence is what a load DEPENDS on where #modeSel is concerned: the change handler
  // snaps every note into the new mode's scale, and a project whose notes were saved in its own mode must
  // come back exactly as written rather than being re-transposed out of it on the way in.
  renderChordPalette();
  renderProjectTitle();
  BB.nextTrackId=1; BB.nextNoteId=1;
  state.tracks = (data.tracks||[]).map(t=>{
    const track = makeTrack(t.name, 0);
    track.id = t.id||BB.nextTrackId; BB.nextTrackId=Math.max(BB.nextTrackId, track.id+1);
    track.color = t.color||track.color; track.muted=!!t.muted; track.solo=!!t.solo; track.volume = t.volume??0.8;
    track.pan = t.pan??50;
    track.instrument = Object.assign(defaultInstrument(), t.instrument||{});
    // the save file carries a sampleId but no audio — if this session's registry still holds that entry
    // (a save/reload round trip without reloading the page) the buffer comes straight back
    resolveTrackSample(track);
    track.notes = (t.notes||[]).map(n=>{ BB.nextNoteId=Math.max(BB.nextNoteId, (n.id||0)+1); return {id:n.id||BB.nextNoteId++, step:n.step, pitch:n.pitch, dur:n.dur, bendTo:n.bendTo??null, bendStartStep:n.bendStartStep??0, bendEndStep:n.bendEndStep??null}; });
    track.regions = (t.regions||null) && t.regions.map(r=>{ BB.nextNoteId=Math.max(BB.nextNoteId, (r.id||0)+1); return {id:r.id||BB.nextNoteId++, start:r.start, end:r.end}; });
    track.automation = defaultAutomation();
    if(t.automation){
      Object.keys(track.automation).forEach(k=>{
        track.automation[k] = (t.automation[k]||[]).map(p=>{ BB.nextNoteId=Math.max(BB.nextNoteId,(p.id||0)+1); return {id:p.id||BB.nextNoteId++, step:p.step, value:p.value}; });
      });
    }
    buildChain(track);
    return track;
  });
  state.selectedTrackId = state.tracks.length? state.tracks[0].id : null;
  state.advancedTrackId = null; state.advancedParam = "volume";
  BB.selectedNoteIds.clear(); BB.selectedRegionIds.clear(); selectedAutoPointIds.clear(); BB.phantomSelection = null;
  resetHistory();
  state.loop = {enabled:false, start:0, end:stepsPerBar()};
  sizeGrid(); buildPianoLabels(); drawGridLines();
  // state.samples is deliberately NOT reset here: the decoded buffers this session holds are the only
  // thing a loaded project's sampleIds can possibly resolve against, since no audio is written to file
  renderSamplePanel();
  renderInstrumentList(); refreshInstrumentEditor(); renderNotes(); buildTrackList(); renderAdvancedEditor();
  recomputeStepsTotal();
  document.getElementById("loopBtn").classList.remove("on");
}
document.getElementById("newBtn").addEventListener("click", ()=>{
  if(!confirm("Start a new project? Unsaved changes will be lost.")) return;
  stopPlayback(true);
  BB.STEPS_TOTAL = STEPS_TOTAL_BASE;
  state.tracks=[]; state.selectedTrackId=null; BB.selectedNoteIds.clear(); BB.selectedRegionIds.clear();
  state.advancedTrackId=null; selectedAutoPointIds.clear(); BB.phantomSelection = null;
  // the sample registry is project data too, so a genuinely new project starts with none — which also
  // takes #sampleMenuBtn back out of .instTopRow (see updateSampleMenuBtn, via renderSamplePanel)
  state.samples=[]; BB.nextSampleId=1; BB.sampleMenuOpen=false; stopSamplePreview();
  resetHistory();
  initDefaultProject();
});
})();

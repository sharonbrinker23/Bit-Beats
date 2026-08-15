# Bit Beats — architecture

The app is plain ES5-era-loading JavaScript split into one file per responsibility, layered
`core` → `audio` / `io` → `ui`, with `app.js` as the entry point. **No build step, no bundler, no ES
modules**: `Bit Beats.html` must open by double-clicking it in Finder, and `file://` blocks module
loads outright, so every file is a classic `<script src>`. Each file wraps itself in its own IIFE with
`"use strict"`, reads the collaborators it needs from one shared namespace, and registers its own
exports back onto it. Lower layers never reach up: the audio engine knows nothing about the DOM, and
the UI never builds an audio node itself.

## Files

| File | Responsibility |
| --- | --- |
| `src/core/constants.js` | Grid geometry, note-name/scale tables, midi↔name/frequency maths |
| `src/core/state.js` | The project document + app-wide selections; `selectedTrack()`/`advTrack()`/`anySolo()` |
| `src/core/samples.js` | The project's registry of uploaded audio samples |
| `src/core/history.js` | Undo/redo — owns both stacks privately; exposes push/undo/redo + 3 helpers |
| `src/audio/engine.js` | Audio graph, the audio-target shape, the voice-factory registry, `playNote` |
| `src/audio/automation.js` | Automation lanes → live audio parameters |
| `src/ui/piano-roll.js` | Note grid: row labels, canvas, tiles, zoom, mode transposition |
| `src/audio/transport.js` | Play/pause, lookahead scheduler, playheads, loop region |
| `src/ui/track-list.js` | Instrument list and the arrange view's track blocks |
| `src/ui/advanced-editor.js` | The advanced track editor's automation lane |
| `src/ui/inst-editor.js` | Instrument editor panel; select/add/delete a track |
| `src/ui/note-editing.js` | Every mouse/keyboard gesture that edits notes on the grid |
| `src/ui/loop-zoom.js` | Loop-region dragging, pinch/slider zoom, undo/redo buttons |
| `src/ui/instrument-list-events.js` | Instrument-row events, track colour picker, arrange-view events |
| `src/ui/header-controls.js` | Header/sub-header controls: key, mode, BPM, project title, transport |
| `src/io/persistence.js` | Save/load/new, and the WAV/MP3/MIDI/JSON export formats |
| `src/ui/panels.js` | Dockable side panels: chord palette and custom sample manager |
| `src/ui/resizers.js` | Draggable panel resizers and the toast |
| `app.js` | Entry point: boots the default project. Loaded last. |

## Namespace convention

One global, `window.BitBeats`, and nothing else is ever put on `window`. Each file opens with:

```js
(function(){
"use strict";
const BB = (window.BitBeats = window.BitBeats || {});
const { NOTE_NAMES, state } = BB;                     // plain values: read once
const renderNotes = (...a)=> BB.renderNotes(...a);    // functions: late-bound forwarders
```

and closes with `Object.assign(BB, { ...its exports });`. Anything a file does not export stays
private to its IIFE. A handful of variables are **mutable and shared** (`STEP_W`, `STEPS_TOTAL`,
`BAR_PX`, `ADV_LANE_H`, the selection sets, the id counters, the drag-state slots, `activeVoices`,
`sampleMenuOpen`). Those live on the namespace object itself and are written as `BB.STEP_W` etc. — a
`const` alias would go stale the moment somebody reassigned them.

## Script-order rule

Script tags in `Bit Beats.html` are listed in the table order above, and that order is the contract:

- A file may **call** a function in any other file — forwarders resolve at call time, so calling
  "downward" into a script listed later is fine and is used throughout (e.g. history restores by
  calling the renderers).
- A file may only **read a plain value** — a constant, the `state` object, a cached DOM element
  handle — from a file listed *above* it, because that value is captured when the file loads.
- `app.js` stays last: it is the only file that boots anything.

`piano-roll.js` is deliberately listed before `transport.js` (the transport reads the roll's cached
`gridScroll` element and its bar/step helpers). Neither file has load-time side effects beyond
declarations and `getElementById`, so the order is free to serve the value-reading rule.

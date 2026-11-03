// Each design-kit component's card in the design system: its group, its
// preview (React.createElement calls over window.Dawg as `D`, `h`), its
// guidelines and its props. The previews render the app's real
// components, from the demo song.

const p = (o) => JSON.stringify(o);
const el = (name, props = {}, ...kids) => `h(D.${name}, ${p(props)}${kids.length ? ", " + kids.join(", ") : ""})`;
const row = (style, ...kids) => `h('div', {style: ${p(style)}}, ${kids.join(", ")})`;

export const COMPONENTS = [
  /* -------------------------------- Controls -------------------------------- */
  {
    name: "Button",
    group: "Controls",
    height: 72,
    subtitle: "default / primary / ghost, small",
    preview: [
      el("Button", {}, "'Open files…'"),
      el("Button", { variant: "primary" }, "'Export'"),
      el("Button", { variant: "ghost" }, "'Cancel'"),
      el("Button", { small: true }, "'+ Device'"),
      el("Button", { disabled: true }, "'Disabled'"),
    ].join(", "),
    readme: `# Button
A labelled button: \`default\` for most, \`primary\` for the one thing a dialog is for (Enter), \`ghost\` for Cancel and other ways out.

- One \`primary\` per dialog, last in the footer row.
- \`small\` sits in panel headers and dense rows (22px tall, fs-md); the default is 26px.
- Text is a verb or a verb phrase in sentence case: "Export", "Open files…", "+ Device". An ellipsis means it opens something.
- Source: \`src/ui/Button.tsx\`.`,
    props: `{ variant?: "default" | "primary" | "ghost"; small?: boolean; disabled?: boolean; children?: React.ReactNode }`,
  },
  {
    name: "ToolButton",
    group: "Controls",
    height: 64,
    subtitle: "title-bar icons, lit when on",
    preview: [
      el("ToolButton", { icon: "play" }),
      el("ToolButton", { icon: "stop" }),
      el("ToolButton", { icon: "loop", on: true }),
      el("ToolButton", { icon: "mixer", on: true }),
      el("ToolButton", { icon: "undo" }),
      el("ToolButton", { icon: "redo", disabled: true }),
      el("ToolButton", { icon: "export" }),
    ].join(", "),
    readme: `# ToolButton
A toolbar button: an icon, or an icon and text, lit (\`on\`) while its thing is on, as the title bar's transport, mixer and history buttons are.

- 20px tall, icons at 12px in \`text-dim\`, \`text\` on hover; \`on\` fills it.
- Give it an \`aria-label\` and a tooltip that names the shortcut: "Play / stop (Space)".
- Source: \`src/ui/Button.tsx\`.`,
    props: `{ icon?: IconName; on?: boolean; disabled?: boolean; children?: React.ReactNode }`,
  },
  {
    name: "CloseButton",
    group: "Controls",
    height: 56,
    subtitle: "md for panels, sm inline",
    preview: [el("CloseButton", {}), el("CloseButton", { size: "sm" })].join(", "),
    readme: `# CloseButton
The × that closes a panel or removes a row or chip. \`md\` (22×20) sits at a panel header's right end; \`sm\` sits inline in a chip or list row.

- Source: \`src/ui/Button.tsx\`.`,
    props: `{ size?: "sm" | "md" }`,
  },
  {
    name: "PowerButton",
    group: "Controls",
    height: 56,
    subtitle: "on / bypassed",
    preview: [el("PowerButton", { on: true }), el("PowerButton", { on: false })].join(", "),
    readme: `# PowerButton
A device's or an EQ band's power: a green dot (\`ok\`) when on, \`line-hover\` when bypassed. It sits first in a device card's title.

- Source: \`src/ui/Button.tsx\`.`,
    props: `{ on: boolean }`,
  },
  {
    name: "Icon",
    group: "Controls",
    height: 64,
    subtitle: "every icon, by name",
    preview: `...["browser","play","stop","loop","mixer","history","undo","redo","export","connect","source","no-loop","close","minimize","maximize","win-close"].map(function(n){return h('span',{key:n,title:n,style:{width:16,height:16,display:'inline-grid',color:'var(--text-dim)'}},h(D.Icon,{name:n}))})`,
    readme: `# Icon
The app's icons, by name: browser, play, stop, loop, mixer, history, undo, redo, export, connect, source, no-loop, close, minimize, maximize, win-close.

- Toolbar icons are 16×16, filled or 1.4px strokes, and take their colour from the button (\`currentColor\`); the window controls are 10×10 hairlines.
- The container sets the size; the icon sets nothing else.
- No emoji, no other icon set. A new icon is added to \`src/ui/Icon.tsx\`.`,
    props: `{ name: "browser" | "play" | "stop" | "loop" | "mixer" | "history" | "undo" | "redo" | "export" | "connect" | "source" | "no-loop" | "close" | "minimize" | "maximize" | "win-close" }`,
  },
  {
    name: "Knob",
    group: "Controls",
    height: 88,
    subtitle: "sizes badge to lg; vol, pan, time",
    preview: [
      el("Knob", { value: 0.7, size: "badge" }),
      el("Knob", { value: 0.7, size: "sm" }),
      el("Knob", { value: 0.7, size: "md" }),
      el("Knob", { value: -0.4, bipolar: true, size: "md", concern: "pan" }),
      el("Knob", { value: 0.35, size: "side", concern: "time" }),
      el("Knob", { value: 0.55, size: "lg" }),
    ].join(", "),
    readme: `# Knob
The arc knob. \`value\` is 0 to 1, or −1 to 1 when \`bipolar\` (pan, gain around 0).

- Sizes are tokens in \`src/ui/tokens.ts\`: \`badge\` 12px inside a clip, \`sm\` 21px for a send level, \`md\` 26px for volume and pan on tracks and strips, \`side\` 34px in a short row, \`lg\` 36px for a labelled param.
- Colour names its concern: \`vol\` (\`k-vol\`) for level, \`pan\` (\`k-pan\`) for stereo, \`time\` (\`k-time\`) for time and shape.
- Source: \`src/ui/Knob.tsx\`.`,
    props: `{ value?: number; bipolar?: boolean; size?: "badge" | "sm" | "md" | "side" | "lg" | number; concern?: "vol" | "pan" | "time" }`,
  },
  {
    name: "KnobField",
    group: "Controls",
    height: 96,
    subtitle: "stack and side layouts",
    preview: [
      el("KnobField", { label: "Threshold", value: "−18.0 dB", f: 0.7 }),
      el("KnobField", { label: "Ratio", value: "4.0:1", f: 0.45, concern: "time" }),
      el("KnobField", { label: "Width", value: "120%", f: 0.6, concern: "pan" }),
      el("KnobField", { label: "Freq", value: "80.0 Hz", f: 0.2, concern: "time", layout: "side", size: "side" }),
    ].join(", "),
    readme: `# KnobField
A knob with its value and name: the one labelled knob, for device params, clip settings and EQ bands.

- \`stack\`: knob, then value (\`text-dim\`, fs-xs), then name (\`text-faint\`, fs-xs). \`side\`: name in capitals over the value, right of the knob, where a row is short.
- Values carry their unit: "−18.0 dB", "4.0:1", "10 ms", "100%". Use the true minus sign.
- Drag up or down, Shift for fine, double-click resets.
- Source: \`src/ui/Knob.tsx\`.`,
    props: `{ label?: string; value?: string; f?: number; bipolar?: boolean; concern?: "vol" | "pan" | "time"; layout?: "stack" | "side"; size?: "sm" | "md" | "side" | "lg" | number }`,
  },
  {
    name: "Volume",
    group: "Controls",
    height: 64,
    subtitle: "with a track or master meter",
    preview: [el("Volume", { db: -2.5, meter: "track", level: -9 }), el("Volume", { db: -1, meter: "master", level: -6 }), el("Volume", { db: 0 })].join(", "),
    readme: `# Volume
The one volume control, for the master and every track: the knob, then the value with "dB", with a level meter before it (track) or after it (master).

- 0 dB sits at 75% of the knob's travel; the bottom is off (−∞).
- Drag up or down (Shift fine, Ctrl 1 dB steps), double-click the number to type, the knob to reset.
- Source: \`src/ui/Volume.tsx\`.`,
    props: `{ db?: number; meter?: "track" | "master" | "none"; level?: number }`,
  },
  {
    name: "LevelMeter",
    group: "Controls",
    height: 72,
    subtitle: "track (vertical), master (horizontal)",
    preview: [el("LevelMeter", { level: -6, right: -10 }), el("LevelMeter", { level: -2, kind: "master" })].join(", "),
    readme: `# LevelMeter
A stereo level meter of two bars: green (\`meter-low\`) to −12 dB, yellow (\`meter-mid\`) to 0 dB, red (\`meter-high\`) over. \`track\` grows up inside a track header's volume; \`master\` grows right in the title bar.

- It moves every frame at the monitor's refresh rate while playing, and is empty when stopped.
- Source: \`src/ui/Meter.tsx\`, laws in \`src/ui/meter-law.ts\`.`,
    props: `{ level?: number; right?: number; kind?: "track" | "master" }`,
  },
  {
    name: "Menu",
    group: "Controls",
    height: 260,
    subtitle: "title, rows with keys, labels, ticks, notes",
    preview: `h('div',{style:{width:240}}, ${el(
      "Menu",
      { title: "Kick" },
      el("MenuItem", { label: "Rename…", keys: "Dbl-click" }),
      el("MenuSep"),
      el("MenuLabel", {}, "'Snap'"),
      el("MenuItem", { label: "Line", checked: true }),
      el("MenuItem", { label: "Beat", checked: false }),
      el("MenuSep"),
      el("MenuItem", { label: "Move up", keys: "Alt+↑", disabled: true }),
      el("MenuItem", { label: "Delete track" }),
      el("MenuNote", {}, "'Right-click a file to label it'"),
    )})`,
    readme: `# Menu
Menus: the box (\`Menu\`) with an optional bold \`title\`, filled with \`MenuItem\` rows (label, keys, tick), \`MenuLabel\` group names in faint capitals, \`MenuSep\` lines and \`MenuNote\` text.

- A dropdown sits under the button it opens from; a context menu sits at the pointer and stays inside the window.
- Rows are verbs in sentence case; keys go right in \`text-faint\`. Destructive rows go last, after a separator.
- Source: \`src/ui/Menu.tsx\`.`,
    props: `{ title?: React.ReactNode; className?: string; children: React.ReactNode }`,
  },
  {
    name: "MenuItem",
    group: "Controls",
    height: 72,
    subtitle: "a menu row",
    preview: `h(D.Menu, null, ${[el("MenuItem", { label: "Show its chain" }), el("MenuItem", { label: "Add track", keys: "Ctrl+Shift+T" })].join(", ")})`,
    readme: `# MenuItem
One menu row: a label, its keys on the right, and a tick column when \`checked\` is set (true or false). \`disabled\` greys it.

- Use it inside \`Menu\`.
- Source: \`src/ui/Menu.tsx\`.`,
    props: `{ label?: string; keys?: string; disabled?: boolean; checked?: boolean }`,
  },
  {
    name: "Dialog",
    group: "Controls",
    height: 260,
    width: 520,
    subtitle: "title, body, button row",
    pad: 0,
    preview: `h('div',{style:{position:'relative',width:520,height:240,transform:'translateZ(0)'}}, ${el(
      "Dialog",
      { label: "Save changes", title: "Save changes to Night Drive?", footer: `__FOOTER__` },
      "h('p',{style:{margin:0,color:'var(--text-dim)'}},'Your changes will be lost if you don\\u2019t save them.')",
    ).replace('"__FOOTER__"', `h(React.Fragment,null,h('span',{style:{flex:1}}),h(D.Button,{variant:'ghost'},'Don\\u2019t save'),h(D.Button,null,'Cancel'),h(D.Button,{variant:'primary'},'Save'))`)})`,
    readme: `# Dialog
A modal dialog over a scrim: a title, a body and a row of buttons. Escape and a click on the scrim cancel it.

- Small (440px) for most; \`wide\` (540px) is the export dialog.
- The title asks or names: "Save changes to Night Drive?". The footer holds the buttons right-aligned, the \`primary\` one last.
- Source: \`src/ui/Dialog.tsx\`.`,
    props: `{ label: string; title: React.ReactNode; wide?: boolean; footer: React.ReactNode; children: React.ReactNode }`,
  },

  /* -------------------------------- Window -------------------------------- */
  {
    name: "TitleBar",
    group: "Window",
    height: 64,
    width: 1600,
    pad: 0,
    subtitle: "menu, tabs, transport, master, history, export",
    preview: `h('div',{style:{width:1600}}, ${el("TitleBar")})`,
    readme: `# TitleBar
The window's title bar: the dawg menu, the session tabs, the transport (browser, play, stop, loop), the playhead readout, BPM, snap, the master volume with its meter and peak, mixer, history, undo and redo, then updates, export and the window buttons.

- 30px tall, on \`page\`. It is the window's drag region.
- Renders \`src/components/TitleBar.tsx\` with the demo song.`,
    props: `{}`,
  },
  {
    name: "StatusBar",
    group: "Window",
    height: 56,
    width: 1600,
    pad: 0,
    subtitle: "hint, agent chip, format",
    preview: `h('div',{style:{width:1600}}, ${el("StatusBar")})`,
    readme: `# StatusBar
The bottom bar: the hint for what's under the pointer (or the default one), the MCP agent chip and the mixdown format.

- Hints are one line of what you can do here, separated by " · ": "Drag to resize this track · Alt+drag resizes all".
- Renders \`StatusBar\` from \`src/App.tsx\`.`,
    props: `{ hint?: string }`,
  },
  {
    name: "EmptyState",
    group: "Window",
    height: 300,
    width: 900,
    subtitle: "the timeline with nothing in it",
    preview: `h('div',{style:{width:860,height:270,display:'flex'}}, ${el("EmptyState")})`,
    readme: `# EmptyState
What the timeline shows with no tracks: a drop target, one sentence on what dropping does, Open files and Open project, and recent projects.

- \`dropping\` lights it while files are dragged over the window.
- Renders \`EmptyState\` from \`src/App.tsx\`.`,
    props: `{ dropping?: boolean }`,
  },

  /* -------------------------------- Timeline -------------------------------- */
  {
    name: "TrackHeader",
    group: "Timeline",
    height: 300,
    subtitle: "name, on/off, solo, volume with meter, pan",
    preview: [
      el("TrackHeader", { name: "Kick", number: 1, category: "drums", gainDb: -2.5, selected: true }),
      el("TrackHeader", { name: "Bass", number: 4, category: "bass", gainDb: -3, pan: -0.2, solo: true }),
      el("TrackHeader", { name: "Riser", number: 7, category: "fx", gainDb: -6, muted: true }),
      el("TrackHeader", { name: "Vox", number: 6, category: "vox", gainDb: -1.5, height: 120 }),
    ]
      .map((x) => `h('div',{style:{width:168}},${x})`)
      .join(", "),
    readme: `# TrackHeader
A track's header on the timeline: its name on its colour, then the number (click to mute: the track plays while lit), solo, the volume knob with its meter, and pan.

- 168px wide (\`hdr-w\`), as tall as its lane (76px default). \`selected\` marks the track whose chain shows.
- \`category\` colours it (drums, perc, bass, leads, pads, vox, fx, foley, ambience, music, ui) and gives the name its icon, unless \`color\` picks a palette index (0 to 7).
- Right-click: rename, category, colour, move, delete. Double-click the name renames.
- Renders \`TrackHeader\` from \`src/components/Editor.tsx\`.`,
    props: `{ name?: string; number?: number; category?: string; color?: number; gainDb?: number; pan?: number; muted?: boolean; solo?: boolean; selected?: boolean; height?: number; level?: number }`,
  },
  {
    name: "Clip",
    group: "Timeline",
    height: 300,
    subtitle: "waveform, fades, envelope, gain",
    preview: [
      el("Clip", { sample: "kick", category: "drums", width: 360, height: 76 }),
      el("Clip", { sample: "bass", category: "bass", width: 360, height: 76, fadeOut: 0.2, selected: true }),
      el("Clip", { sample: "pad", category: "pads", width: 360, height: 76, fadeIn: 0.25, envelope: true }),
      el("Clip", { sample: "vox", category: "vox", width: 360, height: 76, gainDb: -3 }),
    ].join(", "),
    readme: `# Clip
A clip on its lane: the name bar in the track's colour, the waveform, fade handles, the volume envelope when there is one, and its gain badge.

- \`sample\` picks the demo audio: kick, snare, hats, bass, pad, vox, riser. \`fadeIn\` and \`fadeOut\` are shares of the clip's length (0 to 1).
- It fills \`width\` × \`height\`; on the timeline its position and length come from the session.
- Renders \`ClipView\` from \`src/components/Lane.tsx\`; the waveform is the app's own drawing.`,
    props: `{ sample?: "kick" | "snare" | "hats" | "bass" | "pad" | "vox" | "riser"; category?: string; color?: number; width?: number; height?: number; gainDb?: number; fadeIn?: number; fadeOut?: number; envelope?: boolean; selected?: boolean }`,
  },
  {
    name: "TimelinePanel",
    group: "Panels",
    height: 720,
    width: 1400,
    pad: 0,
    subtitle: "the whole Timeline panel",
    preview: `h('div',{style:{width:1400,height:720,display:'flex',flexDirection:'column'}}, ${el("TimelinePanel")})`,
    readme: `# TimelinePanel
The Timeline panel as the app draws it: its header, the ruler, a header and a lane per track with their clips, and the drop row for new tracks.

- It is built from \`TrackHeader\` and \`Clip\`; change those to change it.
- Renders \`TimelineHead\` and \`Editor\` from \`src/components/Editor.tsx\` with the demo song.`,
    props: `{}`,
  },

  /* -------------------------------- Mixer & chain -------------------------------- */
  {
    name: "MixerStrip",
    group: "Mixer",
    height: 290,
    subtitle: "master, channel, muted, selected",
    preview: [
      el("MixerStrip", { master: true, gainDb: -1 }),
      el("MixerStrip", { name: "Kick", number: 1, category: "drums", gainDb: -2.5, selected: true }),
      el("MixerStrip", { name: "Hats", number: 3, category: "perc", gainDb: -9, pan: -0.25 }),
      el("MixerStrip", { name: "Riser", number: 7, category: "fx", gainDb: -6, muted: true }),
      el("MixerStrip", { name: "Vox", number: 6, category: "vox", gainDb: -1.5, solo: true }),
    ]
      .map((x) => `h('div',{style:{height:256,display:'flex'}},${x})`)
      .join(", "),
    readme: `# MixerStrip
One narrow mixer strip: the channel number and name on its colour (with its menu), pan, mute and solo, the volume knob with its meter, and the output port that says where it sends.

- Strips fill the Mixer panel's height; \`master\` is C0, pinned left, with no pan, mute or solo.
- \`selected\` marks the strip whose chain shows; the other strips then show a chevron to send to them.
- Renders \`Strip\` from \`src/components/MixerPanel.tsx\`.`,
    props: `{ name?: string; number?: number; category?: string; color?: number; gainDb?: number; pan?: number; muted?: boolean; solo?: boolean; selected?: boolean; master?: boolean }`,
  },
  {
    name: "MixerPanel",
    group: "Panels",
    height: 280,
    width: 1400,
    pad: 0,
    subtitle: "the whole Mixer panel",
    preview: `h('div',{style:{width:1400,height:256,display:'flex',flexDirection:'column'}}, ${el("MixerPanel")})`,
    readme: `# MixerPanel
The Mixer panel as the app draws it: the master pinned left, a strip per channel in timeline order, + for a mixer-only channel, and the send cables under the strips.

- 256px tall by default; strips fill its height.
- Renders \`MixerPanel\` from \`src/components/MixerPanel.tsx\` with the demo song.`,
    props: `{}`,
  },
  {
    name: "DeviceCard",
    group: "Mixer",
    height: 260,
    subtitle: "EQ, Compressor, Utility; bypassed, folded",
    preview: [
      `h('div',{style:{width:640,height:210,display:'flex'}},${el("DeviceCard", { kind: "eq", category: "drums" })})`,
      `h('div',{style:{height:210,display:'flex'}},${el("DeviceCard", { kind: "compressor" })})`,
      `h('div',{style:{height:210,display:'flex'}},${el("DeviceCard", { kind: "utility", on: false })})`,
      `h('div',{style:{height:210,display:'flex'}},${el("DeviceCard", { kind: "eq", folded: true })})`,
    ].join(", "),
    readme: `# DeviceCard
A device's card in the Chain panel: the power dot, its name, the compressor's sidechain input, its menu, and its controls: the EQ's curve and band editor, the compressor's knobs and gain reduction meter, or the utility's gain, width and toggles.

- \`on\` false shows it bypassed; \`folded\` keeps only the title, as a double-click does.
- The EQ curve and nodes take the track's colour (\`category\`).
- Renders \`DeviceCard\` from \`src/components/ChainPanel.tsx\` and the bodies in \`src/components/Devices.tsx\`.`,
    props: `{ kind?: "eq" | "compressor" | "utility"; name?: string; on?: boolean; folded?: boolean; selected?: boolean; category?: string }`,
  },
  {
    name: "ChainPanel",
    group: "Panels",
    height: 280,
    width: 1400,
    pad: 0,
    subtitle: "the whole Chain panel",
    preview: `h('div',{style:{width:1400,height:252,display:'flex',flexDirection:'column'}}, ${el("ChainPanel")})`,
    readme: `# ChainPanel
The Chain panel as the app draws it: the selected channel's input, devices and output in its header, then its device cards left to right in signal order, + for a device, and its volume and pan, which are always last.

- Renders \`ChainPanel\` from \`src/components/ChainPanel.tsx\` with the demo song (C1 Kick).`,
    props: `{}`,
  },

  /* -------------------------------- Browser & history -------------------------------- */
  {
    name: "BrowserPanel",
    group: "Panels",
    height: 640,
    width: 240,
    pad: 0,
    subtitle: "search, pins, recent, labels, folders",
    preview: `h('div',{style:{width:208,height:620,display:'flex',flexDirection:'column'}}, ${el("BrowserPanel")})`,
    readme: `# BrowserPanel
The Browser panel: search, Group by folder or type, favourites, pinned folders, recent files, labels and folders, each a section that folds.

- 208px wide by default, docked left.
- Renders \`Browser\` from \`src/components/Browser.tsx\`.`,
    props: `{}`,
  },
  {
    name: "HistoryPanel",
    group: "Panels",
    height: 360,
    width: 420,
    subtitle: "every edit, where and what",
    preview: `h('div',{style:{position:'relative',width:380,height:330}}, ${el("HistoryPanel")})`,
    readme: `# HistoryPanel
The History dropdown under the title bar's history button: each edit with its icon, where it happened ("Vox › EQ › Band 2 Bell") and what changed ("0.0 → −3.5 dB"), newest last; AI edits carry the \`ai\` badge.

- Click a step to go back to it.
- Renders \`HistoryPanel\` from \`src/components/HistoryPanel.tsx\`.`,
    props: `{}`,
  },
  {
    name: "ExportDialog",
    group: "Panels",
    height: 560,
    width: 720,
    pad: 0,
    subtitle: "the Export dialog, open",
    preview: `h('div',{style:{position:'relative',width:720,height:540,transform:'translateZ(0)'}}, ${el("ExportDialog")})`,
    readme: `# ExportDialog
The Export dialog: the format, depth, rate and range of a mixdown, with its peak and where it goes.

- The wide dialog (540px). Export is its primary button.
- Renders \`ExportDialog\` from \`src/components/ExportDialog.tsx\`.`,
    props: `{}`,
  },
];

export const README = `dawg is a Windows DAW for quick sound design: drag WAVs or MP3s onto tracks, shape clips, export. The UI is dark, dense and quiet: an Ableton-like layout with FL Studio's habits and Audacity's simplicity.

Every component here is the app's own code, rendered from a demo song. To change how one looks, change it in the app (\`src/ui\`, \`src/components\`, \`src/tokens.css\`) and rebuild this system with \`npm run design:build\`. Token edits made on this page are copied back into \`src/tokens.css\`.

## Content

- Sentence case everywhere: buttons, menus, titles. Capitals only for section labels (\`text-11\` in \`text-faint\`, letter-spaced).
- Verbs on buttons and menu rows: "Export", "Open files…", "Add track". An ellipsis means it opens a dialog or picker.
- Hints in the status bar are what you can do here, joined by " · ": "Drag to resize this track · Alt+drag resizes all · double-click resets". Name keys as Ctrl+S, Shift, Alt+drag.
- Numbers carry units and the true minus: "−18.0 dB", "4.0:1", "120 ms", "48 kHz", "L25", "C". Channels are C0 (master), C1, C2…
- No emoji, no exclamation marks. Say what happens: "Each file gets its own track, all starting at the same point so they layer."

## Colour

- One dark theme. Surfaces step up from \`page\` (the dock) through \`bg-0\`, \`bg-1\` (panels, headers, dialogs) to \`bg-3\` (buttons, menus, cards) and \`bg-4\` (hover).
- Text is \`text\` for values and names, \`text-dim\` for secondary, \`text-faint\` for labels that repeat what's nearby.
- Colour is meaning, not decoration. Knob arcs say their concern: \`k-vol\` level, \`k-pan\` stereo, \`k-time\` time and shape. Meters go \`meter-low\` → \`meter-mid\` → \`meter-high\`. \`solo\`, \`mute\`, \`ok\` and \`gr\` are states. \`ai\` (purple) is reserved for the AI coproducer and nothing else.
- Tracks and clips take a palette colour from their category (Drums, Bass, Vox…); text on a track colour is \`ink\`.

## Type

- Manrope (variable) everywhere, numbers included, with tabular figures so changing numbers keep their width.
- The scale is small: \`text-md\` (12px) is the body; \`text-xs\` (10px) for knob values and names; \`text-lg\` (13px) for names; \`text-xl\` (15px, semibold) for dialog titles.
- Weights: 400 for text, 500 for values (\`nw\`), 600 for buttons and titles.

## Shape and space

- Corners are small: \`r-lg\` (6px) on buttons, \`r-xl\` (8px) on menus and cards, \`r-2xl\` (10px) on dialogs, \`r-round\` for knobs and dots.
- Gaps come from \`sp-1\` (2px) to \`sp-7\` (24px); most rows use \`sp-2\` to \`sp-4\`.
- Borders, not shadows, separate things on the window: \`line\` between rows and panels, \`line-strong\` around controls. Shadows only for what floats: \`shadow-md\` menus, \`shadow-lg\` floating panels, \`shadow-xl\` dialogs.

## Motion

- Meters, the playhead, waveforms and the EQ analyser move every frame at the monitor's refresh rate. Nothing else animates.

## Layout

- The window is a title bar, a dock of panels (Browser left; Timeline, Mixer and Chain stacked right) and a status bar. Panels dock and float; each has a 26px header with its title.
- Track headers are \`hdr-w\` (168px) wide. Mixer strips are narrow and fill the panel's height.

## Iconography

- The app's own icons, by name, through \`Icon\` (16×16 toolbar icons, filled or 1.4px strokes, in \`currentColor\`). No icon font, no emoji. Category icons live with the Browser's labels.
- The dawg mark is \`DawgMark\`: a line-drawn dog, in \`currentColor\`.

## Building screens

- Lay screens out in plain markup and mount the components inside: \`TitleBar\` on top, \`StatusBar\` at the bottom, panels between.
- A timeline is a column of rows, each a \`TrackHeader\` beside a lane of \`Clip\`s; a mixer is a row of \`MixerStrip\`s after the master; a chain is a row of \`DeviceCard\`s.
- \`TimelinePanel\`, \`MixerPanel\`, \`ChainPanel\`, \`BrowserPanel\` and \`HistoryPanel\` are the whole panels as the app draws them, for checking a composed screen against the app.
`;

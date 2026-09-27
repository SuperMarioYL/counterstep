// gen-assets.mjs — counterstep site SVG generator.
//
// Reads web/palette.json (single source of color truth, produced by the pinned
// renderer's scripts/palette.js) and writes every themed figure into web/assets/:
//
//   scene-dark.svg / scene-light.svg                     static scene fallbacks (no animation)
//   process|architecture|invertibility-{light,dark}.svg  story figures (CSS animation, reduced-motion safe)
//   ...-mobile-{light,dark}.svg                          narrow compositions of the same figures
//   demo-0..9-{light,dark}.svg                           recorded-demo terminal panels (verbatim record text)
//
// No <script>, no remote fonts or images. Each root carries data-palette=<palette.id>.
// Usage: node web/gen-assets.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const palette = JSON.parse(fs.readFileSync(path.join(HERE, "palette.json"), "utf8"));
const PID = palette.id;
const OUT = path.join(HERE, "assets");
fs.mkdirSync(OUT, { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const SANS = "Arial,'Helvetica Neue','Noto Sans',sans-serif";

// Word-wrap for terminal panels; display-only (the record in site.json stays verbatim).
function wrap(text, width) {
  const lines = [];
  for (const raw of String(text).split("\n")) {
    if (raw.length <= width) {
      lines.push(raw);
      continue;
    }
    let indent = "";
    let current = "";
    for (const word of raw.split(" ")) {
      const candidate = current ? current + " " + word : word;
      if (candidate.length + indent.length > width && current) {
        lines.push(indent + current);
        indent = "  ";
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(indent + current);
  }
  return lines;
}

// ---- shared chrome ---------------------------------------------------------
function frame(pfx, w, h, title, desc, theme, animated, inner) {
  const T = palette[theme];
  const dark = theme === "dark";
  const anim = animated
    ? `.${pfx}-flow{animation:${pfx}-fdash 5.5s linear infinite}@keyframes ${pfx}-fdash{to{stroke-dashoffset:-190}}.${pfx}-pulse{animation:${pfx}-fpulse 4.2s ease-in-out infinite}@keyframes ${pfx}-fpulse{0%,100%{opacity:.4}50%{opacity:1}}@media (prefers-reduced-motion:reduce){*{animation:none !important}}`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-palette="${PID}" role="img" aria-labelledby="${pfx}-t ${pfx}-d"><title id="${pfx}-t">${esc(title)}</title><desc id="${pfx}-d">${esc(desc)}</desc>
<defs>
<linearGradient id="${pfx}-brand" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${T.primary}"/><stop offset="0.55" stop-color="${T.secondary}"/><stop offset="1" stop-color="${T.highlight}"/></linearGradient>
<radialGradient id="${pfx}-halo" cx="0.5" cy="0.32" r="0.9"><stop stop-color="${T.primary}" stop-opacity="${dark ? 0.16 : 0.09}"/><stop offset="1" stop-color="${T.bg}" stop-opacity="0"/></radialGradient>
<filter id="${pfx}-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<marker id="${pfx}-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto"><path d="m1 1 7 4-7 4" fill="none" stroke="${T.primary}" stroke-width="1.6"/></marker>
<marker id="${pfx}-arrowm" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto"><path d="m1 1 7 4-7 4" fill="none" stroke="${T.muted}" stroke-width="1.6"/></marker>
</defs>
<style>text{font-family:${SANS}}.${pfx}-mono{font-family:${MONO}}${anim}</style>
<rect width="${w}" height="${h}" rx="16" fill="${T.bg}"/>
<rect width="${w}" height="${h}" rx="16" fill="url(#${pfx}-halo)"/>
<pattern id="${pfx}-grid" width="46" height="46" patternUnits="userSpaceOnUse"><path d="M46 0H0V46" fill="none" stroke="${T.line}" stroke-opacity="${dark ? 0.3 : 0.55}" stroke-width="0.6"/></pattern>
<rect width="${w}" height="${h}" rx="16" fill="url(#${pfx}-grid)"/>
${inner}
</svg>
`;
}

const box = (T, x, y, w, h, accent, rx = 12) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${T.panel}" stroke="${accent ? T.primary : T.line}" stroke-width="${accent ? 1.7 : 1.1}"/>`;
const label = (T, x, y, text, o = {}) => {
  const { size = 15, weight = 600, fill = "ink", mono = false, anchor = "start", pfx = "", opacity = 1 } = o;
  const f = fill === "ink" ? T.ink : fill === "muted" ? T.muted : fill === "primary" ? T.primary : fill === "secondary" ? T.secondary : fill === "highlight" ? T.highlight : fill;
  return `<text x="${x}" y="${y}" fill="${f}" font-size="${size}" font-weight="${weight}" opacity="${opacity}"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}${mono ? ` class="${pfx}-mono"` : ""}>${esc(text)}</text>`;
};
const flow = (T, pfx, d, o = {}) => {
  const { muted = false, width = 1.7 } = o;
  return `<path d="${d}" fill="none" stroke="${muted ? T.muted : T.primary}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="5 7" marker-end="url(#${pfx}-${muted ? "arrowm" : "arrow"})" class="${pfx}-flow"/>`;
};
const edge = (T, pfx, d, muted = false) =>
  `<path d="${d}" fill="none" stroke="${muted ? T.muted : T.primary}" stroke-width="1.4" marker-end="url(#${pfx}-${muted ? "arrowm" : "arrow"})"/>`;
const dot = (T, cx, cy, r, o = 0.5, color = "primary") =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${T[color]}" opacity="${o}"/>`;
const chip = (T, pfx, x, y, text, o = {}) => {
  const { size = 12.5, accent = false, mono = true, fill = null } = o;
  const w = text.length * size * (mono ? 0.62 : 0.58) + 20;
  const stroke = accent ? T.primary : T.line;
  const txt = fill || (accent ? T.primary : T.muted);
  return { w, svg: `<g><rect x="${x}" y="${y}" width="${w}" height="${size + 14}" rx="${(size + 14) / 2}" fill="${T.panel}" stroke="${stroke}" stroke-width="1.1"/>` + label(T, x + 10, y + size + 2, text, { size, weight: 500, fill: txt, mono, pfx }) + `</g>` };
};

function panelTitle(T, pfx, x, y, title, sub) {
  let s = label(T, x, y, title, { size: 23, weight: 700, pfx });
  if (sub) s += label(T, x, y + 24, sub, { size: 13.5, weight: 400, fill: "muted", pfx });
  return s;
}

// ---- 1. scene fallbacks (static brand still — never animated) ---------------
function scene(theme) {
  const T = palette[theme];
  const dark = theme === "dark";
  const p = `sc-${theme[0]}`;
  const W = 1200, H = 640;
  // fixed particle field (a still of the hero's particle graph)
  const dots = [
    [200, 140, 2.2, 0.35], [268, 108, 3, 0.5], [352, 150, 2.2, 0.35], [166, 220, 2.6, 0.45],
    [246, 196, 2.2, 0.3], [900, 120, 2.6, 0.45], [986, 168, 2.2, 0.35], [1054, 110, 3, 0.5],
    [1108, 210, 2.2, 0.35], [836, 96, 2.2, 0.3], [560, 92, 2.4, 0.4], [660, 120, 2, 0.3],
    [96, 420, 2.4, 0.4], [140, 520, 2, 0.3], [1080, 470, 2.6, 0.45], [1128, 560, 2.2, 0.35],
    [1010, 540, 2, 0.3], [620, 590, 2.2, 0.3], [520, 560, 2, 0.3],
  ].map(([x, y, r, o]) => dot(T, x, y, r, o)).join("");

  let s = "";
  // fingerprint annotation
  s += box(T, 430, 96, 340, 62, true, 31);
  s += label(T, 600, 122, "sha256 fingerprint — pre-action state", { size: 14, anchor: "middle", fill: "primary", pfx: p });
  s += label(T, 600, 144, "fs scope · remote ref read from the remote", { size: 12, anchor: "middle", fill: "muted", pfx: p });
  s += edge(T, p, "M600 158 L600 208");
  // agent call card
  s += box(T, 60, 240, 268, 120, false);
  s += label(T, 80, 270, "coding agent", { size: 15, weight: 700, pfx: p });
  s += label(T, 80, 296, "rm -rf src/legacy", { size: 12.5, fill: "muted", mono: true, pfx: p });
  s += label(T, 80, 318, "git push --force origin main", { size: 12.5, fill: "muted", mono: true, pfx: p });
  s += label(T, 80, 342, "PreToolUse · stdin JSON", { size: 11.5, fill: "secondary", mono: true, pfx: p });
  // hook core
  s += `<rect x="452" y="208" width="296" height="120" rx="16" fill="${T.panel}" stroke="url(#${p}-brand)" stroke-width="2" filter="url(#${p}-glow)"/>`;
  s += label(T, 600, 246, "counterstep hook", { size: 19, weight: 700, anchor: "middle", fill: "ink", pfx: p });
  s += label(T, 600, 272, "deny until armed", { size: 13.5, weight: 600, anchor: "middle", fill: "primary", pfx: p });
  s += label(T, 600, 296, "classify · construct inverse · rehearse", { size: 11.5, anchor: "middle", fill: "muted", pfx: p });
  s += label(T, 600, 314, "one process per call", { size: 11.5, anchor: "middle", fill: "muted", pfx: p });
  // shadow rehearsal
  s += box(T, 300, 470, 280, 96, false);
  s += label(T, 320, 500, "shadow copy — rehearsal", { size: 14.5, weight: 700, pfx: p });
  s += label(T, 320, 524, "inverse applied to a copy of the", { size: 12, fill: "muted", pfx: p });
  s += label(T, 320, 542, "scope; fingerprint must restore", { size: 12, fill: "muted", pfx: p });
  s += edge(T, p, "M540 328 C500 380, 450 420, 440 470");
  // ledger
  s += box(T, 640, 470, 320, 96, true);
  s += label(T, 660, 500, ".counterstep/ledger.jsonl", { size: 14.5, weight: 700, mono: true, fill: "primary", pfx: p });
  s += label(T, 660, 524, "armed inverses with verified fingerprints", { size: 12, fill: "muted", pfx: p });
  s += label(T, 660, 542, "counterstep fire --last → undo, re-verified", { size: 12, fill: "secondary", mono: true, pfx: p });
  s += edge(T, p, "M660 328 C700 380, 740 420, 760 470");
  // released call
  s += box(T, 916, 240, 224, 120, false);
  s += label(T, 936, 270, "call released", { size: 15, weight: 700, fill: "highlight", pfx: p });
  s += label(T, 936, 296, "fs_restore · git_push_ref", { size: 12, fill: "muted", mono: true, pfx: p });
  s += label(T, 936, 318, "armed before the forward", { size: 11.5, fill: "muted", pfx: p });
  s += label(T, 936, 336, "call runs", { size: 11.5, fill: "muted", pfx: p });
  s += edge(T, p, "M748 268 L916 268");
  // incoming particles
  s += flow(T, p, "M328 300 L452 268", {});
  s += dot(T, 372, 288, 2.6, 0.6);
  s += dot(T, 404, 280, 2, 0.45);
  s += dots;
  // wordmark
  s += label(T, 600, 606, "Counterstep — the rehearsed undo ledger", { size: 13, anchor: "middle", fill: "muted", weight: 500, pfx: p });
  return frame(p, W, H, "Counterstep scene", "Illustrative still: a destructive call is held by the counterstep hook while its inverse is fingerprint-checked and rehearsed, then armed in the ledger.", theme, false, s);
}

// ---- 2. process figure ------------------------------------------------------
const PROCESS_STAGES = [
  { n: "01", t: "Intercept", d1: "PreToolUse payload over Bash, Write,", d2: "Edit, MultiEdit, NotebookEdit" },
  { n: "02", t: "Fingerprint", d1: "sha256 of the affected state: recursive", d2: "fs content, or the remote ref's target" },
  { n: "03", t: "Construct the inverse", d1: "fs_restore — shadow snapshot of paths;", d2: "git_push_ref — force-with-lease rewind" },
  { n: "04", t: "Shadow rehearsal", d1: "inverse applied to a shadow copy; it must", d2: "drive the fingerprint back to the armed value" },
  { n: "05", t: "Arm & release", d1: "artifact appended to ledger.jsonl, then —", d2: "and only then — the forward call runs" },
];

function processDesktop(theme) {
  const T = palette[theme];
  const p = `pc-${theme[0]}`;
  const W = 1150, H = 668;
  const cardW = 320, cardH = 148;
  const row1 = [{ x: 40 }, { x: 415 }, { x: 790 }];
  const row2 = [{ x: 810, w: 300 }, { x: 415, w: 320 }, { x: 40, w: 320 }]; // right-to-left flow
  const y1 = 118, y2 = 356;
  let s = panelTitle(T, p, 40, 46, "Fingerprint, rehearse, arm", "One destructive call, from interception to an armed undo — typically seconds");
  PROCESS_STAGES.forEach((st, i) => {
    const pos = i < 3 ? row1[i] : row2[i - 3];
    const y = i < 3 ? y1 : y2;
    const x = pos.x;
    const w = pos.w || cardW;
    s += box(T, x, y, w, cardH, i === 3);
    s += label(T, x + 20, y + 36, st.n, { size: 15, weight: 700, fill: "primary", mono: true, pfx: p });
    s += label(T, x + 58, y + 36, st.t, { size: 16.5, weight: 700, pfx: p });
    s += label(T, x + 20, y + 68, st.d1, { size: 12.5, weight: 400, fill: "muted", pfx: p });
    s += label(T, x + 20, y + 88, st.d2, { size: 12.5, weight: 400, fill: "muted", pfx: p });
    if (i === 3) s += `<rect x="${x}" y="${y}" width="4" height="${cardH}" rx="2" fill="${T.primary}"/>`;
  });
  // row1 forward arrows
  s += flow(T, p, "M360 192 L415 192");
  s += flow(T, p, "M735 192 L790 192");
  // serpentine: 03 bottom -> 04 top
  s += flow(T, p, "M950 266 L950 356");
  // 04 -> 05 (rehearsal passed)
  s += flow(T, p, "M810 430 L735 430");
  s += label(T, 772, 402, "rehearsal", { size: 11.5, fill: "primary", anchor: "middle", pfx: p });
  s += label(T, 772, 418, "passed", { size: 11.5, fill: "primary", anchor: "middle", pfx: p });
  // 04 -> denied (no oracle), elbow below the row
  s += flow(T, p, "M960 504 L960 536 L190 536 L190 510", { muted: true });
  s += label(T, 575, 556, "no oracle — reason stated", { size: 11.5, fill: "muted", anchor: "middle", pfx: p });
  // denied card
  const dx = 40, dy = 356;
  s += box(T, dx, dy, 320, cardH, false);
  s += label(T, dx + 20, dy + 36, "BLOCKED", { size: 15, weight: 700, fill: "secondary", mono: true, pfx: p });
  s += label(T, dx + 20, dy + 68, "globs · outside workspace · git reset --hard ·", { size: 12.5, weight: 400, fill: "muted", pfx: p });
  s += label(T, dx + 20, dy + 88, "third-party HTTP writes — the denial carries", { size: 12.5, weight: 400, fill: "muted", pfx: p });
  s += label(T, dx + 20, dy + 108, "the reason (docs/invertibility.md)", { size: 12.5, weight: 400, fill: "muted", pfx: p });
  // pass-through lane
  s += box(T, 40, 566, 1070, 62, false, 10);
  s += flow(T, p, "M80 597 L1040 597", { muted: true });
  s += label(T, 575, 590, "non-destructive calls pass through untouched", { size: 13.5, anchor: "middle", fill: "ink", weight: 600, pfx: p });
  s += label(T, 575, 614, "only the destructive class is intercepted", { size: 11.5, anchor: "middle", fill: "muted", pfx: p });
  return frame(p, W, H, "Counterstep process", "The deny-until-armed handshake: intercept the destructive call, fingerprint the state, construct the inverse, rehearse on a shadow copy, then arm and release; ops with no oracle are denied with the reason stated.", theme, true, s);
}

function processMobile(theme) {
  const T = palette[theme];
  const p = `pm-${theme[0]}`;
  const W = 640, H = 1010;
  const x = 36, cw = 568, ch = 118;
  let s = panelTitle(T, p, 36, 44, "Fingerprint, rehearse, arm", "One destructive call, from interception to an armed undo");
  let y = 100;
  PROCESS_STAGES.forEach((st, i) => {
    s += box(T, x, y, cw, ch, i === 3);
    s += label(T, x + 18, y + 34, st.n, { size: 14, weight: 700, fill: "primary", mono: true, pfx: p });
    s += label(T, x + 52, y + 34, st.t, { size: 16.5, weight: 700, pfx: p });
    s += label(T, x + 18, y + 64, st.d1, { size: 12.5, weight: 400, fill: "muted", pfx: p });
    s += label(T, x + 18, y + 84, st.d2, { size: 12.5, weight: 400, fill: "muted", pfx: p });
    if (i === 3) s += `<rect x="${x}" y="${y}" width="4" height="${ch}" rx="2" fill="${T.primary}"/>`;
    if (i < 4) s += flow(T, p, `M320 ${y + ch} L320 ${y + ch + 34}`);
    y += ch + 34;
  });
  // denied card
  s += box(T, x, y, cw, ch, false);
  s += label(T, x + 18, y + 34, "BLOCKED — no oracle, denied with reason", { size: 14, weight: 700, fill: "secondary", mono: true, pfx: p });
  s += label(T, x + 18, y + 64, "globs · outside workspace · git reset --hard ·", { size: 12.5, weight: 400, fill: "muted", pfx: p });
  s += label(T, x + 18, y + 84, "third-party HTTP writes — docs/invertibility.md", { size: 12.5, weight: 400, fill: "muted", pfx: p });
  s += flow(T, p, `M320 ${y - 34} L320 ${y}`, { muted: true });
  y += ch + 30;
  s += box(T, x, y, cw, 64, false, 10);
  s += label(T, x + cw / 2, y + 27, "non-destructive calls pass through untouched", { size: 13.5, anchor: "middle", weight: 600, pfx: p });
  s += label(T, x + cw / 2, y + 49, "only the destructive class is intercepted", { size: 11.5, anchor: "middle", fill: "muted", pfx: p });
  return frame(p, W, H, "Counterstep process", "The deny-until-armed handshake, narrow composition: intercept, fingerprint, construct, rehearse, arm and release; ops with no oracle are denied with the reason stated.", theme, true, s);
}

// ---- 3. architecture figure --------------------------------------------------
function architectureDesktop(theme) {
  const T = palette[theme];
  const p = `ar-${theme[0]}`;
  const W = 1150, H = 668;
  let s = panelTitle(T, p, 40, 46, "One CLI, state is a directory", "Zero daemons, no database — one process per hook invocation, append-only JSONL");
  // session
  s += box(T, 40, 128, 300, 190, false);
  s += label(T, 60, 160, "Claude Code session", { size: 16, weight: 700, pfx: p });
  s += label(T, 60, 190, "PreToolUse · stdin JSON", { size: 12.5, fill: "secondary", mono: true, pfx: p });
  s += label(T, 60, 216, "Bash · Write · Edit", { size: 12.5, fill: "muted", mono: true, pfx: p });
  s += label(T, 60, 238, "MultiEdit · NotebookEdit", { size: 12.5, fill: "muted", mono: true, pfx: p });
  s += label(T, 60, 272, "every destructive call passes", { size: 12, fill: "muted", pfx: p });
  s += label(T, 60, 290, "the hook before it runs", { size: 12, fill: "muted", pfx: p });
  // hook
  s += `<rect x="420" y="128" width="340" height="304" rx="14" fill="${T.panel}" stroke="url(#${p}-brand)" stroke-width="1.8"/>`;
  s += label(T, 440, 160, "counterstep hook", { size: 16.5, weight: 700, pfx: p });
  s += label(T, 440, 182, "one process per call", { size: 12, fill: "muted", pfx: p });
  const mods = [
    ["classify", "destructive class?"],
    ["adapters/claude_code.ts", "stdio hook handler"],
    ["compensation.ts", "build the inverse"],
    ["fingerprint.ts", "sha256 oracle"],
    ["rehearse.ts", "shadow-copy proof"],
  ];
  mods.forEach(([m, d], i) => {
    const y = 208 + i * 42;
    s += box(T, 440, y, 300, 32, i === 0, 8);
    s += label(T, 452, y + 21, m, { size: 12, weight: 600, mono: true, fill: i === 0 ? "primary" : "ink", pfx: p });
    s += label(T, 728, y + 21, d, { size: 11, fill: "muted", anchor: "end", pfx: p });
  });
  // state dir
  s += box(T, 840, 128, 270, 150, true);
  s += label(T, 858, 158, ".counterstep/", { size: 15.5, weight: 700, mono: true, fill: "primary", pfx: p });
  s += label(T, 858, 186, "ledger.jsonl — append-only", { size: 12, fill: "muted", mono: true, pfx: p });
  s += label(T, 858, 208, "shadow/<artifact-id>/", { size: 12, fill: "muted", mono: true, pfx: p });
  s += label(T, 858, 236, "armed inverses + shadow", { size: 11.5, fill: "muted", pfx: p });
  s += label(T, 858, 254, "rehearsal payloads", { size: 11.5, fill: "muted", pfx: p });
  // developer
  s += box(T, 840, 318, 270, 114, false);
  s += label(T, 858, 348, "developer", { size: 15.5, weight: 700, pfx: p });
  s += label(T, 858, 376, "counterstep ledger", { size: 12, fill: "ink", mono: true, pfx: p });
  s += label(T, 858, 398, "counterstep fire --last", { size: 12, fill: "primary", mono: true, pfx: p });
  s += label(T, 858, 420, "verify fingerprint, execute", { size: 11.5, fill: "muted", pfx: p });
  // edges
  s += flow(T, p, "M340 200 L420 200");
  s += label(T, 380, 188, "stdin", { size: 11, fill: "muted", anchor: "middle", mono: true, pfx: p });
  s += flow(T, p, "M760 200 L840 200");
  s += label(T, 800, 188, "armed", { size: 11, fill: "primary", anchor: "middle", mono: true, pfx: p });
  s += flow(T, p, "M975 318 L975 286", { muted: true });
  s += label(T, 992, 306, "ledger · fire", { size: 11, fill: "muted", mono: true, pfx: p });
  // status strip
  s += box(T, 40, 500, 1070, 128, false, 12);
  const statuses = [
    ["armed", "rehearsal passed, call released"],
    ["fired", "undo executed, fingerprint matches"],
    ["stale", "live state drifted — inspect first"],
    ["failed", "inverse could not run; remote untouched"],
  ];
  statuses.forEach(([k, d], i) => {
    const x = 64 + i * 262;
    s += box(T, x, 522, 238, 40, k === "armed", 9);
    s += label(T, x + 14, 547, k, { size: 13, weight: 700, mono: true, fill: k === "armed" ? "primary" : "ink", pfx: p });
    s += label(T, x, 590, d, { size: 11.5, fill: "muted", pfx: p });
  });
  s += label(T, 575, 640, "firing re-verifies the fingerprint — drift is surfaced, never silently clobbered", { size: 12.5, anchor: "middle", fill: "muted", pfx: p });
  return frame(p, W, H, "Counterstep architecture", "How Counterstep is built: the Claude Code PreToolUse hook feeds a single-process CLI with classify, adapter, compensation, fingerprint and rehearsal modules, state kept in a .counterstep directory with an append-only JSONL ledger and shadow store.", theme, true, s);
}

function architectureMobile(theme) {
  const T = palette[theme];
  const p = `am-${theme[0]}`;
  const W = 640, H = 1150;
  let s = panelTitle(T, p, 36, 44, "One CLI, state is a directory", "Zero daemons, no database — one process per hook invocation");
  const x = 36, cw = 568;
  let y = 100;
  s += box(T, x, y, cw, 108, false);
  s += label(T, x + 18, y + 34, "Claude Code session", { size: 16, weight: 700, pfx: p });
  s += label(T, x + 18, y + 62, "PreToolUse · stdin JSON", { size: 12.5, fill: "secondary", mono: true, pfx: p });
  s += label(T, x + 18, y + 86, "Bash · Write · Edit · MultiEdit · NotebookEdit", { size: 12.5, fill: "muted", mono: true, pfx: p });
  s += flow(T, p, `M320 ${y + 108} L320 ${y + 142}`);
  y += 142;
  s += `<rect x="${x}" y="${y}" width="${cw}" height="270" rx="14" fill="${T.panel}" stroke="url(#${p}-brand)" stroke-width="1.8"/>`;
  s += label(T, x + 18, y + 32, "counterstep hook", { size: 16.5, weight: 700, pfx: p });
  s += label(T, x + 18, y + 54, "one process per call", { size: 12, fill: "muted", pfx: p });
  const mods = [
    ["classify", "destructive class?"],
    ["adapters/claude_code.ts", "stdio hook handler"],
    ["compensation.ts", "build the inverse"],
    ["fingerprint.ts", "sha256 oracle"],
    ["rehearse.ts", "shadow-copy proof"],
  ];
  mods.forEach(([m, d], i) => {
    const yy = y + 70 + i * 38;
    s += box(T, x + 18, yy, cw - 36, 28, i === 0, 8);
    s += label(T, x + 30, yy + 19, m, { size: 11.5, weight: 600, mono: true, fill: i === 0 ? "primary" : "ink", pfx: p });
    s += label(T, x + cw - 30, yy + 19, d, { size: 10.5, fill: "muted", anchor: "end", pfx: p });
  });
  s += flow(T, p, `M320 ${y + 270} L320 ${y + 304}`);
  y += 304;
  s += box(T, x, y, cw, 116, true);
  s += label(T, x + 18, y + 32, ".counterstep/", { size: 15.5, weight: 700, mono: true, fill: "primary", pfx: p });
  s += label(T, x + 18, y + 60, "ledger.jsonl — append-only armed inverses", { size: 12.5, fill: "muted", mono: true, pfx: p });
  s += label(T, x + 18, y + 84, "shadow/<artifact-id>/ rehearsal payloads", { size: 12.5, fill: "muted", mono: true, pfx: p });
  s += flow(T, p, `M320 ${y + 116} L320 ${y + 150}`);
  y += 150;
  s += box(T, x, y, cw, 100, false);
  s += label(T, x + 18, y + 32, "developer", { size: 15.5, weight: 700, pfx: p });
  s += label(T, x + 18, y + 60, "counterstep ledger · counterstep fire --last", { size: 12.5, fill: "primary", mono: true, pfx: p });
  s += label(T, x + 18, y + 84, "verify fingerprint, execute the inverse", { size: 12, fill: "muted", pfx: p });
  y += 134;
  const statuses = [
    ["armed", "rehearsal passed, call released"],
    ["fired", "undo executed, fingerprint matches"],
    ["stale", "live state drifted — inspect first"],
    ["failed", "inverse could not run; remote untouched"],
  ];
  statuses.forEach(([k, d], i) => {
    const yy = y + i * 74;
    s += box(T, x, yy, cw, 58, k === "armed", 9);
    s += label(T, x + 16, yy + 25, k, { size: 13.5, weight: 700, mono: true, fill: k === "armed" ? "primary" : "ink", pfx: p });
    s += label(T, x + 16, yy + 46, d, { size: 12, fill: "muted", pfx: p });
  });
  y += 4 * 74 + 16;
  s += label(T, x + cw / 2, y + 20, "firing re-verifies the fingerprint — drift is surfaced, never silently clobbered", { size: 12.5, anchor: "middle", fill: "muted", pfx: p });
  return frame(p, W, H, "Counterstep architecture", "How Counterstep is built, narrow composition: session, hook modules, .counterstep state directory, developer ledger commands and the four artifact statuses.", theme, true, s);
}

// ---- 4. invertibility figure --------------------------------------------------
const INV = {
  a: {
    head: "Class A — intercepted & invertible",
    sub: "armed, then allowed",
    count: 15,
    chips: ["rm <file>", "rm -rf <dir>", "mv (rename / clobber)", "Write / Edit overwrite", "MultiEdit / NotebookEdit", "git push --force", "git push -f / --force-with-lease", "push :<ref> (ref delete)"],
    tail: "inverse: fs_restore from the shadow snapshot · git_push_ref back to the armed sha",
  },
  b: {
    head: "Class B — intercepted, blocked",
    sub: "the reason is stated in the denial",
    count: 12,
    chips: ["rm -f *.log (glob)", "outside the workspace", "rm .counterstep/", "git push --force (no refspec)", "push to a new branch", "git reset --hard", "curl -X POST/PUT/DELETE", "wget --post-file", "httpie verbs"],
    tail: "what the shell expands, whole-repo discards and third-party writes admit no scoped, rehearsal-verifiable inverse",
  },
  c: {
    head: "Class C — not yet intercepted",
    sub: "the v0.2 backlog, one oracle at a time",
    count: 14,
    chips: ["git clean -fd", "git checkout -- / git restore", "> file (redirection)", "find -delete", "truncate", "git branch -D", "npm publish", "kubectl delete", "terraform destroy"],
    tail: "runs through the harness's normal permission flow — documented so the gap is explicit, never implied",
  },
};

function invBand(T, p, x, y, w, cls, accent) {
  let s = "";
  const pad = 20;
  const usable = w - 2 * pad - 16;
  // chip flow (measure first, then place — so wraps are correct)
  let cx = x + pad, cy = y + 72, rows = 1;
  cls.chips.forEach((c) => {
    const cw = c.length * 12 * 0.62 + 20;
    if (cx + cw > x + pad + usable) {
      cx = x + pad;
      cy += 34;
      rows += 1;
    }
    s += chip(T, p, cx, cy, c, { size: 12 }).svg;
    cx += cw + 10;
  });
  // tail, wrapped to the band width
  const tailSize = 11.5;
  const tailMax = Math.floor((w - 2 * pad) / (tailSize * 0.58));
  const tailLines = wrap(cls.tail, tailMax);
  const tailY = cy + 26 + 22;
  const h = tailY + tailLines.length * 17 + 12 - y;
  s = box(T, x, y, w, h, accent)
    + `<rect x="${x}" y="${y}" width="4" height="${h}" rx="2" fill="${accent ? T.primary : T.line}"/>`
    + label(T, x + 20, y + 32, cls.head, { size: 16, weight: 700, pfx: p })
    + label(T, x + 20, y + 54, cls.sub, { size: 12, fill: "muted", pfx: p })
    + `<rect x="${x + w - 78}" y="${y + 14}" width="58" height="30" rx="15" fill="${T.panel}" stroke="${T.primary}" stroke-width="1.2"/>`
    + label(T, x + w - 49, y + 34, String(cls.count), { size: 14, weight: 700, anchor: "middle", fill: "primary", mono: true, pfx: p })
    + s;
  tailLines.forEach((line, i) => {
    s += label(T, x + 20, tailY + i * 17, line, { size: tailSize, fill: "muted", pfx: p });
  });
  return { svg: s, h };
}

function invertibilityDesktop(theme) {
  const T = palette[theme];
  const p = `iv-${theme[0]}`;
  let s = panelTitle(T, p, 40, 46, "What the ledger can and cannot undo", "The destructive call surface, classified against the implemented mechanism · docs/invertibility.md");
  let y = 104;
  for (const cls of [INV.a, INV.b, INV.c]) {
    const band = invBand(T, p, 40, y, 1070, cls, cls === INV.a);
    s += band.svg;
    y += band.h + 24;
  }
  s += label(T, 575, y + 4, "blocked is not denied forever — every refusal carries its reason, and expansion is gated one oracle at a time", { size: 12.5, anchor: "middle", fill: "muted", pfx: p });
  return frame(p, 1150, y + 28, "Counterstep invertibility", "Classification of the destructive call surface: fifteen ops arm verified inverses, twelve are blocked with the reason stated, and fourteen are not yet intercepted and form the v0.2 backlog.", theme, true, s);
}

function invertibilityMobile(theme) {
  const T = palette[theme];
  const p = `im-${theme[0]}`;
  let s = panelTitle(T, p, 36, 44, "What the ledger can and cannot undo", "Classified against the implemented mechanism · docs/invertibility.md");
  let y = 100;
  for (const cls of [INV.a, INV.b, INV.c]) {
    const band = invBand(T, p, 36, y, 568, cls, cls === INV.a);
    s += band.svg;
    y += band.h + 24;
  }
  s += label(T, 320, y + 4, "blocked is not denied forever — every refusal carries its reason", { size: 12.5, anchor: "middle", fill: "muted", pfx: p });
  return frame(p, 640, y + 28, "Counterstep invertibility", "Classification of the destructive call surface, narrow composition: fifteen armed inverses, twelve blocked with reasons, fourteen not yet intercepted.", theme, true, s);
}

// ---- 5. demo panels (verbatim record text) -----------------------------------
const record = JSON.parse(fs.readFileSync(path.join(HERE, "..", "docs", "demo-results.json"), "utf8"));

const STATUS_OF = [
  "SETUP", "ARMED", "LEDGER", "WIPED", "FIRED", "FIRED",
  "ARMED", "PUSHED", "FIRED", "FIRED",
];

function demoPanel(i, theme) {
  const T = palette[theme];
  const p = `dm${i}-${theme[0]}`;
  const W = 920;
  const padX = 26;
  const cmdLines = wrap(record.commands[i].command, 104);
  const outLines = [];
  for (const line of record.commands[i].output) outLines.push(...wrap(line, 106));
  const headH = 44;
  const h = headH + 22 + cmdLines.length * 22 + 14 + outLines.length * 21 + 22;

  let s = "";
  // terminal chrome
  s += `<rect x="0" y="0" width="${W}" height="${headH}" rx="14" fill="${T.code}"/><rect x="0" y="${headH - 14}" width="${W}" height="14" fill="${T.code}"/>`;
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, k) => {
    s += `<circle cx="${22 + k * 18}" cy="${headH / 2}" r="5.5" fill="${c}" opacity="0.85"/>`;
  });
  s += label(T, 92, headH / 2 + 4, `docs/demo-results.json — step ${i + 1} of ${record.commands.length}`, { size: 11.5, fill: "muted", mono: true, pfx: p });
  const st = STATUS_OF[i];
  const stFill = st === "ARMED" ? "primary" : st === "FIRED" ? "highlight" : st === "WIPED" || st === "PUSHED" ? "secondary" : "muted";
  s += `<rect x="${W - 108}" y="${headH / 2 - 12}" width="86" height="24" rx="12" fill="${T.panel}" stroke="${T[stFill]}" stroke-width="1.1" opacity="0.95"/>`;
  s += label(T, W - 65, headH / 2 + 4, st, { size: 10.5, weight: 700, anchor: "middle", fill: stFill, mono: true, pfx: p });
  // command
  let y = headH + 22;
  cmdLines.forEach((line, k) => {
    const prefix = k === 0 ? "$ " : "› ";
    s += label(T, padX, y, prefix + line, { size: 13.5, weight: 600, fill: k === 0 ? "ink" : "muted", mono: true, pfx: p });
    y += 22;
  });
  y += 6;
  s += `<line x1="${padX}" y1="${y - 12}" x2="${W - padX}" y2="${y - 12}" stroke="${T.line}" stroke-width="1"/>`;
  outLines.forEach((line) => {
    let fill = "ink", weight = 500;
    if (line.startsWith("counterstep:")) { fill = "primary"; weight = 700; }
    else if (line.startsWith("{")) fill = "muted";
    else if (/^(ls:|fatal|error)/i.test(line)) fill = "secondary";
    s += label(T, padX, y, line, { size: 13, weight, fill, mono: true, pfx: p });
    y += 21;
  });
  // caret
  s += `<rect x="${padX}" y="${y - 13}" width="8" height="15" fill="${T.primary}" class="${p}-caret"/>`;
  s = s.replace("</style>", `.${p}-caret{animation:${p}-blink 1.1s steps(1) infinite}@keyframes ${p}-blink{50%{opacity:0}}@media (prefers-reduced-motion:reduce){.${p}-caret{animation:none}}</style>`);
  return frame(p, W, h, `Recorded demo step ${i + 1}`, `${record.commands[i].command} — verbatim output from docs/demo-results.json`, theme, true, s);
}

// ---- emit --------------------------------------------------------------------
const files = {
  "scene-dark.svg": scene("dark"),
  "scene-light.svg": scene("light"),
  "process-light.svg": processDesktop("light"),
  "process-dark.svg": processDesktop("dark"),
  "process-mobile-light.svg": processMobile("light"),
  "process-mobile-dark.svg": processMobile("dark"),
  "architecture-light.svg": architectureDesktop("light"),
  "architecture-dark.svg": architectureDesktop("dark"),
  "architecture-mobile-light.svg": architectureMobile("light"),
  "architecture-mobile-dark.svg": architectureMobile("dark"),
  "invertibility-light.svg": invertibilityDesktop("light"),
  "invertibility-dark.svg": invertibilityDesktop("dark"),
  "invertibility-mobile-light.svg": invertibilityMobile("light"),
  "invertibility-mobile-dark.svg": invertibilityMobile("dark"),
};
record.commands.forEach((_, i) => {
  files[`demo-${i}-light.svg`] = demoPanel(i, "light");
  files[`demo-${i}-dark.svg`] = demoPanel(i, "dark");
});

for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), svg, "utf8");
}
console.log(`wrote ${Object.keys(files).length} SVGs into ${OUT} (palette ${PID})`);

#!/usr/bin/env node
// Renders the demo from real runs (docs/media/demo.svg and docs/media/demo.mp4).
//   node scripts/make-demo.mjs [--no-video] [--font <ttf file>]
// It runs the three examples (`pnpm exec tsc -b` first), keeps their real output, and types each run into a terminal
// window, one scene after the other: an animated SVG (CSS; still under prefers-reduced-motion) and an H.264 video made
// with ffmpeg's drawtext. The captions are fixed text; everything else comes from the runs, so the demo cannot show
// output the examples do not print.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noVideo = args.includes('--no-video');
const fontArg = args[args.indexOf('--font') + 1];
const out = join(root, 'docs', 'media');
mkdirSync(out, { recursive: true });

const SCENES = [
  {
    file: 'quickstart',
    command: 'pnpm example:quickstart',
    caption:
      'A task waits on a timer, holding no worker, then completes with its result',
  },
  {
    file: 'price-watch',
    command: 'pnpm example:price-watch',
    caption:
      'A monitoring agent watches a price feed and reports back through the assistant',
  },
  {
    file: 'expense-approval',
    command: 'pnpm example:expense-approval',
    caption:
      'A task waits for a human approval in the manager\u2019s inbox, then pays',
  },
];
// Break a line that is wider than the window at a space, the rest indented.
const wrap = (line, width = 80) => {
  const rows = [];
  let rest = line;
  let indent = '';
  while (indent.length + rest.length > width) {
    let cut = rest.lastIndexOf(' ', width - indent.length);
    if (cut <= 0) cut = width - indent.length;
    rows.push(indent + rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
    indent = '  ';
  }
  rows.push(indent + rest);
  return rows;
};
for (const s of SCENES)
  s.lines = execFileSync(
    process.execPath,
    [join(root, 'packages', 'examples', 'dist', `${s.file}.js`)],
    { cwd: root, encoding: 'utf8' },
  )
    .trimEnd()
    .split('\n')
    .flatMap((l) =>
      wrap(l).map((text, i) => ({ text, src: l, first: i === 0 })),
    );

const W = 960;
const H = 470;
const PAD = 32;
const LH = 25;
const FS = 18;
const CW = FS * 0.6;
const perChar = 0.05;
const lineGap = 0.55;
const Y0 = 100;

// Colour by speaker; a result line is green.
const color = (t) =>
  /^(user|employee|manager)>/.test(t)
    ? ['#ffa657', '0xffa657']
    : /^manager inbox>/.test(t)
      ? ['#d2a8ff', '0xd2a8ff']
      : /^assistant>/.test(t)
        ? ['#79c0ff', '0x79c0ff']
        : /^(result>|monitor task: completed|task: completed)/.test(t) ||
            /"status": "completed"/.test(t)
          ? ['#7ee787', '0x7ee787']
          : ['#c9d1d9', '0xc9d1d9'];

// Timeline: every scene has absolute start and end times.
let cursor = 0.4;
for (const s of SCENES) {
  s.start = cursor;
  s.typeAt = cursor + 0.6;
  s.typeEnd = s.typeAt + s.command.length * perChar;
  s.outAt = s.typeEnd + 0.8;
  s.items = s.lines.map((l, i) => ({
    text: l.text,
    src: l.src,
    at: s.outAt + i * lineGap,
  }));
  s.end = s.outAt + s.lines.length * lineGap + 3.2;
  cursor = s.end;
}
const total = cursor + 0.4;
const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (t) => Math.min(100, Math.max(0, (t / total) * 100)).toFixed(3);

// ---- animated SVG ------------------------------------------------------------------------------------------------
const css = [];
const rows = [];
let k = 0;
const anim = (frames) => {
  const name = `k${k++}`;
  css.push(`@keyframes ${name}{${frames}}`);
  return `animation:${name} ${total.toFixed(2)}s linear infinite`;
};
for (const s of SCENES) {
  const hide = `${pct(s.end)}%{opacity:0}`;
  // caption bar
  rows.push(
    `<text x="${PAD}" y="${H - 24}" class="cap" style="${anim(`0%,${pct(s.start)}%{opacity:0}${pct(s.start + 0.3)}%,${pct(s.end - 0.2)}%{opacity:1}${hide}100%{opacity:0}`)}">${esc(s.caption)}</text>`,
  );
  // typed command: clip grows, whole line leaves with the scene
  rows.push(
    `<g style="${anim(`0%,${pct(s.start)}%{opacity:0}${pct(s.start + 0.05)}%,${pct(s.end - 0.2)}%{opacity:1}${hide}100%{opacity:0}`)}"><text x="${PAD}" y="${Y0}" class="p">$ </text></g>`,
  );
  rows.push(
    `<text x="${PAD + 2 * CW}" y="${Y0}" class="c" style="${anim(`0%,${pct(s.typeAt)}%{clip-path:inset(0 100% 0 0);opacity:1}${pct(s.typeEnd)}%{clip-path:inset(0 0 0 0);opacity:1}${pct(s.end - 0.2)}%{clip-path:inset(0 0 0 0);opacity:1}${pct(s.end)}%,100%{clip-path:inset(0 0 0 0);opacity:0}`)}">${esc(s.command)}</text>`,
  );
  s.items.forEach((l, i) => {
    const [fill] = color(l.text);
    rows.push(
      `<text x="${PAD}" y="${Y0 + LH * (i + 2)}" fill="${fill}" style="${anim(`0%,${pct(l.at)}%{opacity:0}${pct(l.at + 0.08)}%,${pct(s.end - 0.2)}%{opacity:1}${hide}100%{opacity:0}`)}">${esc(l.text)}</text>`,
    );
  });
}
// Under reduced motion show the last scene whole, with its caption.
const last = SCENES[SCENES.length - 1];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">Agentropy demo</title>
<desc id="d">Three runs in a terminal. A reminder task waits on a timer and completes. A monitoring agent watches ACME and tells the user it fell to 99. An expense of 4200 waits for the manager to approve, then is paid.</desc>
<style>
text{font:${FS}px Consolas,Menlo,'DejaVu Sans Mono',monospace;white-space:pre;opacity:0}
.p{fill:#7ee787}.c{fill:#e6edf3}.cap{font-size:15px;fill:#8b949e}
${css.join('')}
@media (prefers-reduced-motion:reduce){text{animation:none!important}.final{opacity:1!important}}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect width="${W}" height="40" rx="10" fill="#161b22"/><rect y="30" width="${W}" height="10" fill="#161b22"/>
<circle cx="24" cy="20" r="6" fill="#ff5f56"/><circle cx="46" cy="20" r="6" fill="#ffbd2e"/><circle cx="68" cy="20" r="6" fill="#27c93f"/>
<text x="${W / 2}" y="26" text-anchor="middle" style="font-size:14px;fill:#8b949e;opacity:1">agentropy, examples</text>
<line x1="${PAD}" x2="${W - PAD}" y1="${H - 48}" y2="${H - 48}" stroke="#21262d"/>
${rows.join('\n')}
<g class="final" style="opacity:0">
<text x="${PAD}" y="${Y0}" class="p">$ </text><text x="${PAD + 2 * CW}" y="${Y0}" class="c">${esc(last.command)}</text>
${last.lines.map((l, i) => `<text x="${PAD}" y="${Y0 + LH * (i + 2)}" fill="${color(l.src)[0]}">${esc(l.text)}</text>`).join('\n')}
<text x="${PAD}" y="${H - 24}" class="cap">${esc(last.caption)}</text>
</g>
</svg>
`;
// The "final" group must stay hidden unless motion is reduced: its text inherits opacity:0 from the group, and the
// media query above turns the group on.
writeFileSync(
  join(out, 'demo.svg'),
  svg.replace(
    '.final{opacity:1!important}',
    '.final{opacity:1!important}.final text{opacity:1!important}',
  ),
);
console.log('wrote docs/media/demo.svg');

// ---- video ---------------------------------------------------------------------------------------------------------
if (!noVideo) {
  const font =
    fontArg ??
    (process.platform === 'win32'
      ? 'C:/Windows/Fonts/consola.ttf'
      : process.platform === 'darwin'
        ? '/System/Library/Fonts/Menlo.ttc'
        : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf');
  const tmp = mkdtempSync(join(tmpdir(), 'agentropy-demo-'));
  const filters = [`drawbox=x=0:y=0:w=${W}:h=40:color=0x161b22:t=fill`];
  filters.push(
    `drawbox=x=${PAD}:y=${H - 48}:w=${W - 2 * PAD}:h=1:color=0x21262d:t=fill`,
  );
  let n = 0;
  const draw = (text, x, y, from, to, col, size = FS) => {
    const f = `t${n++}.txt`;
    writeFileSync(join(tmp, f), text);
    const en = `between(t,${from.toFixed(2)},${to.toFixed(2)})`;
    filters.push(
      `drawtext=fontfile='${font.replace(':', '\\:')}':textfile=${f}:fontsize=${size}:fontcolor=${col}:x=${x}:y=${y}:enable='${en}'`,
    );
  };
  const ty = (y) => y - 15;
  for (const s of SCENES) {
    const to = s.end - 0.2;
    draw(s.caption, PAD, H - 24 - 13, s.start + 0.3, to, '0x8b949e', 15);
    draw('$', PAD, ty(Y0), s.start + 0.05, to, '0x7ee787');
    for (let i = 1; i <= s.command.length; i++) {
      const a = s.typeAt + (i - 1) * perChar;
      const b = i === s.command.length ? to : s.typeAt + i * perChar;
      draw(s.command.slice(0, i), PAD + 2 * CW, ty(Y0), a, b, '0xe6edf3');
    }
    s.items.forEach((l, i) => {
      if (l.text.trim())
        draw(l.text, PAD, ty(Y0 + LH * (i + 2)), l.at, to, color(l.src)[1]);
    });
  }
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x0d1117:s=${W}x${H}:r=25:d=${total.toFixed(2)}`,
      '-vf',
      filters.join(','),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '24',
      '-movflags',
      '+faststart',
      join(out, 'demo.mp4'),
    ],
    { cwd: tmp, stdio: 'inherit' },
  );
  rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) {
    console.error(
      'ffmpeg failed (is it installed? use --no-video to skip the video)',
    );
    process.exit(1);
  }
  console.log('wrote docs/media/demo.mp4');
}

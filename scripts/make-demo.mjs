#!/usr/bin/env node
// Renders the quickstart demo from a real run (docs/media/quickstart-demo.svg and .mp4).
//   node scripts/make-demo.mjs [--no-video] [--font <ttf file>]
// It runs `node packages/examples/dist/quickstart.js` (build first: `pnpm exec tsc -b`), keeps its real output, and
// types it into a terminal window: an animated SVG (CSS, still under prefers-reduced-motion) and an H.264 video made
// with ffmpeg's drawtext. Nothing here is recorded by hand, so the demo cannot show output the example does not print.
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

const command = 'pnpm example:quickstart';
const real = execFileSync(
  process.execPath,
  [join(root, 'packages', 'examples', 'dist', 'quickstart.js')],
  { cwd: root, encoding: 'utf8' },
)
  .trimEnd()
  .split('\n');

// Timeline in seconds: the command is typed, then the output appears line by line.
const typeStart = 0.8;
const perChar = 0.06;
const typed = command.length * perChar;
const outStart = typeStart + typed + 0.7;
const lineGap = 0.35;
const outputLines = real.map((text, i) => ({
  text,
  at: outStart + i * lineGap,
}));
const end = outStart + real.length * lineGap + 2.5;
const W = 960;
const H = 440;
const PAD = 32;
const LH = 26;
const FS = 18;

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (t) => ((t / end) * 100).toFixed(2);

// ---- animated SVG ----------------------------------------------------------------------------------------------
const css = [];
const rows = [];
const y0 = 96;
const promptCss = `@keyframes ty{0%,${pct(typeStart)}%{clip-path:inset(0 100% 0 0)}${pct(typeStart + typed)}%,100%{clip-path:inset(0 0 0 0)}}`;
css.push(promptCss);
rows.push(
  `<text x="${PAD}" y="${y0}" class="p">$ </text><text x="${PAD + 2 * 10.8}" y="${y0}" class="c" style="animation:ty ${end}s steps(${command.length}) infinite">${esc(command)}</text>`,
);
outputLines.forEach((l, i) => {
  css.push(
    `@keyframes l${i}{0%,${pct(l.at)}%{opacity:0}${pct(l.at + 0.05)}%,100%{opacity:1}}`,
  );
  rows.push(
    `<text x="${PAD}" y="${y0 + LH * (i + 2)}" xml:space="preserve" class="o" style="animation:l${i} ${end}s linear infinite">${esc(l.text)}</text>`,
  );
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">Agentropy quickstart</title>
<desc id="d">A terminal runs pnpm example:quickstart and prints a completed task whose output holds the reminder "stand-up in 5 minutes".</desc>
<style>
.p{fill:#7ee787}.c{fill:#e6edf3}.o{fill:#c9d1d9}
text{font:${FS}px Consolas,Menlo,'DejaVu Sans Mono',monospace;white-space:pre}
${css.join('')}
@media (prefers-reduced-motion:reduce){text{animation:none!important;opacity:1!important;clip-path:none!important}}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect width="${W}" height="40" rx="10" fill="#161b22"/><rect y="30" width="${W}" height="10" fill="#161b22"/>
<circle cx="24" cy="20" r="6" fill="#ff5f56"/><circle cx="46" cy="20" r="6" fill="#ffbd2e"/><circle cx="68" cy="20" r="6" fill="#27c93f"/>
<text x="${W / 2}" y="26" text-anchor="middle" style="font-size:14px;fill:#8b949e">agentropy, quickstart</text>
${rows.join('\n')}
</svg>
`;
writeFileSync(join(out, 'quickstart-demo.svg'), svg);
console.log('wrote docs/media/quickstart-demo.svg');

// ---- video ----------------------------------------------------------------------------------------------------
if (!noVideo) {
  const font =
    fontArg ??
    (process.platform === 'win32'
      ? 'C:/Windows/Fonts/consola.ttf'
      : process.platform === 'darwin'
        ? '/System/Library/Fonts/Menlo.ttc'
        : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf');
  const tmp = mkdtempSync(join(tmpdir(), 'agentropy-demo-'));
  const filters = [];
  let n = 0;
  const draw = (text, x, y, from, to, color) => {
    const f = `t${n++}.txt`;
    writeFileSync(join(tmp, f), text);
    const en = to === undefined ? `gte(t,${from})` : `between(t,${from},${to})`;
    filters.push(
      `drawtext=fontfile='${font.replace(':', '\\:')}':textfile=${f}:fontsize=${FS}:fontcolor=${color}:x=${x}:y=${y}:enable='${en}'`,
    );
  };
  const cw = FS * 0.55;
  draw('$', PAD, y0 - 14, 0, undefined, '0x7ee787');
  for (let i = 1; i <= command.length; i++) {
    const from = (typeStart + (i - 1) * perChar).toFixed(2);
    const to =
      i === command.length ? undefined : (typeStart + i * perChar).toFixed(2);
    draw(command.slice(0, i), PAD + 2 * cw, y0 - 14, from, to, '0xe6edf3');
  }
  outputLines.forEach((l, i) => {
    if (l.text.trim())
      draw(
        l.text,
        PAD,
        y0 - 14 + LH * (i + 2),
        l.at.toFixed(2),
        undefined,
        '0xc9d1d9',
      );
  });
  const vf = [
    `drawbox=x=0:y=0:w=${W}:h=40:color=0x161b22:t=fill`,
    ...filters,
  ].join(',');
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x0d1117:s=${W}x${H}:r=25:d=${end.toFixed(2)}`,
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '24',
      '-movflags',
      '+faststart',
      join(out, 'quickstart-demo.mp4'),
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
  console.log('wrote docs/media/quickstart-demo.mp4');
}

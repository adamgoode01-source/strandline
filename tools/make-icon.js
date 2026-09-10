/* Builds the iOS app icon and splash from tools/icon-source.png.
 *
 * Two things have to be corrected before Apple will take it:
 *
 *  1. The source has rounded corners baked in, with white outside them. iOS
 *     applies its own squircle mask, so shipping it as-is double-masks the
 *     artwork and leaves white wedges around the edge. The corners are filled
 *     back in with the background navy so the image is a true full square.
 *  2. App icons must carry no alpha channel, and must be exactly 1024x1024.
 *
 * Requires sharp, which is deliberately NOT a project dependency - it would be
 * pulled on every CI install for something that runs once when the brand
 * changes. Install it wherever you like and point SHARP at it, or run:
 *
 *   npm --prefix ./.iconbuild install sharp
 *   node tools/make-icon.js ./.iconbuild/node_modules/sharp
 */

const path = require('path');
const fs = require('fs');

const SHARP = process.argv[2] || 'sharp';
let sharp;
try { sharp = require(SHARP); }
catch (e) {
  console.error('Could not load sharp from "' + SHARP + '".');
  console.error('Pass the path as the first argument. See the header of this file.');
  process.exit(1);
}

const ROOT   = path.join(__dirname, '..');
const SRC    = path.join(__dirname, 'icon-source.png');
const ICON   = path.join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
const SPLASH = path.join(ROOT, 'ios/App/App/Assets.xcassets/Splash.imageset');

const NAVY = { r: 11, g: 25, b: 44 };

// Fraction of the edge used as the corner radius in the source artwork,
// measured from it: the diagonal runs 88px into a 1254px image before hitting
// the background, and r = inset / (1 - 1/sqrt(2)).
const RADIUS_FRAC = 305 / 1254;

async function squareOff(srcPath) {
  const img = sharp(srcPath).removeAlpha();
  const { width, height } = await img.metadata();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  // Radius is nudged out slightly so the anti-aliased ring at the original
  // boundary is covered too, rather than surviving as a pale halo.
  const r = Math.round(Math.min(w, h) * RADIUS_FRAC);

  const out = Buffer.from(data);
  const outside = (x, y) => {
    const cx = x < r ? r : (x > w - 1 - r ? w - 1 - r : x);
    const cy = y < r ? r : (y > h - 1 - r ? h - 1 - r : y);
    if (cx === x && cy === y) return false;             // straight edge, inside
    const dx = x - cx, dy = y - cy;
    return (dx * dx + dy * dy) > r * r;
  };
  let filled = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!outside(x, y)) continue;
      const o = (y * w + x) * ch;
      out[o] = NAVY.r; out[o + 1] = NAVY.g; out[o + 2] = NAVY.b;
      filled++;
    }
  }
  console.log('  corner pixels filled: ' + filled.toLocaleString() +
              ' (' + (filled / (w * h) * 100).toFixed(1) + '% of the image)');
  return sharp(out, { raw: { width: w, height: h, channels: ch } });
}

async function main() {
  if (!fs.existsSync(SRC)) { console.error('Missing ' + SRC); process.exit(1); }

  const squared = await squareOff(SRC);
  const flat = await squared.png().toBuffer();

  // App icon: exactly 1024x1024, RGB, no alpha.
  await sharp(flat)
    .resize(1024, 1024, { kernel: 'lanczos3', fit: 'fill' })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(ICON);
  console.log('  wrote AppIcon-512@2x.png  1024x1024');

  // Splash: the mark centred on the same navy, well inside the safe area
  // because the launch image is cropped differently on every device.
  const markSize = Math.round(2732 * 0.34);
  const mark = await sharp(flat).resize(markSize, markSize, { kernel: 'lanczos3' }).png().toBuffer();
  const splash = await sharp({
      create: { width: 2732, height: 2732, channels: 3, background: NAVY }
    })
    .composite([{ input: mark, gravity: 'centre' }])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    fs.writeFileSync(path.join(SPLASH, f), splash);
  }
  console.log('  wrote 3 splash images       2732x2732');

  for (const [label, p] of [['icon', ICON], ['splash', path.join(SPLASH, 'splash-2732x2732.png')]]) {
    const b = fs.readFileSync(p);
    const ct = b[25];
    console.log('  ' + label.padEnd(7) + b.readUInt32BE(16) + 'x' + b.readUInt32BE(20) +
                '  colourType ' + ct + (ct === 2 ? ' (RGB, no alpha - correct)' : ' (HAS ALPHA - would be rejected)') +
                '  ' + (b.length / 1024).toFixed(0) + ' KB');
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

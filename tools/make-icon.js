// Generates the Strandline app icon as a PNG, with no image-library dependency.
// The mark is the same yellow "S" the app header uses, drawn as two stroked arcs.
const zlib = require('zlib');
const fs = require('fs');

const BG = [0x12, 0x12, 0x12];
const FG = [0xF2, 0xC5, 0x11];

function crc32(buf){
  let c, table = [];
  for(let n=0;n<256;n++){ c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320 ^ (c>>>1) : c>>>1; table[n]=c>>>0; }
  let crc = 0xFFFFFFFF;
  for(const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgb){
  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(height,4);
  ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;   // 8-bit RGB
  const raw = Buffer.alloc(height*(1+width*3));
  for(let y=0;y<height;y++){
    raw[y*(1+width*3)] = 0;                                    // filter: none
    rgb.copy(raw, y*(1+width*3)+1, y*width*3, (y+1)*width*3);
  }
  return Buffer.concat([sig, chunk('IHDR',ihdr),
    chunk('IDAT', zlib.deflateSync(raw,{level:9})), chunk('IEND', Buffer.alloc(0))]);
}

const norm = a => { while(a < -360) a += 360; while(a > 360) a -= 360; return a; };
// shortest distance from p to a circular arc, with round caps
function arcDist(px, py, cx, cy, r, a0, a1){
  const dx = px-cx, dy = py-cy;
  let ang = Math.atan2(dy,dx) * 180/Math.PI;
  const len = Math.hypot(dx,dy);
  // put the angle in [a0, a0+360) so ranges that cross +/-180 still match
  const a = a0 + ((((ang - a0) % 360) + 360) % 360);
  if(a <= a1) return Math.abs(len - r);
  const e0x = cx + r*Math.cos(a0*Math.PI/180), e0y = cy + r*Math.sin(a0*Math.PI/180);
  const e1x = cx + r*Math.cos(a1*Math.PI/180), e1y = cy + r*Math.sin(a1*Math.PI/180);
  return Math.min(Math.hypot(px-e0x,py-e0y), Math.hypot(px-e1x,py-e1y));
}

function render(S){
  const buf = Buffer.alloc(S*S*3);
  const cx = S/2, cy = S/2;
  const r  = S*0.171;          // arc radius
  const sw = S*0.062;          // half stroke width
  const U = {cx, cy: cy-r, a0:-270, a1:-45};   // top of the S
  const L = {cx, cy: cy+r, a0:-90,  a1:135};   // bottom of the S
  const SS = 4;                                 // supersampling for clean edges
  for(let y=0;y<S;y++){
    for(let x=0;x<S;x++){
      let hits = 0;
      for(let sy=0;sy<SS;sy++) for(let sx=0;sx<SS;sx++){
        const px = x + (sx+0.5)/SS, py = y + (sy+0.5)/SS;
        const d = Math.min(
          arcDist(px,py,U.cx,U.cy,r,U.a0,U.a1),
          arcDist(px,py,L.cx,L.cy,r,L.a0,L.a1));
        if(d <= sw) hits++;
      }
      const t = hits/(SS*SS);
      const o = (y*S+x)*3;
      for(let k=0;k<3;k++) buf[o+k] = Math.round(BG[k]*(1-t) + FG[k]*t);
    }
  }
  return png(S,S,buf);
}

const out = process.argv[2] || 'icon-1024.png';
const size = +(process.argv[3] || 1024);
fs.writeFileSync(out, render(size));
console.log('wrote', out, size+'x'+size, fs.statSync(out).size, 'bytes');

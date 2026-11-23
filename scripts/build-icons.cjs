// Export the approved square PNG into a Windows ICO with native size variants.
// This is a format/size conversion; the logo artwork remains unchanged.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function bitmapFrame(png, size) {
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) throw new Error('Expected a non-interlaced RGBA PNG.');
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = size * 4;
  const rgba = Buffer.alloc(size * stride);
  let source = 0;
  const paeth = (left, up, upperLeft) => {
    const prediction = left + up - upperLeft;
    const a = Math.abs(prediction - left), b = Math.abs(prediction - up), c = Math.abs(prediction - upperLeft);
    return a <= b && a <= c ? left : b <= c ? up : upperLeft;
  };
  for (let y = 0; y < size; y++) {
    const filter = raw[source++];
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= 4 ? rgba[at - 4] : 0;
      const up = y ? rgba[at - stride] : 0;
      const upperLeft = y && x >= 4 ? rgba[at - stride - 4] : 0;
      const predictors = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)];
      if (filter > 4) throw new Error('Invalid PNG filter.');
      rgba[at] = (raw[source++] + predictors[filter]) & 255;
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const pixels = size * stride;
  const result = Buffer.alloc(40 + pixels + size * maskStride);
  result.writeUInt32LE(40, 0);
  result.writeInt32LE(size, 4);
  result.writeInt32LE(size * 2, 8);
  result.writeUInt16LE(1, 12);
  result.writeUInt16LE(32, 14);
  result.writeUInt32LE(pixels, 20);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const from = ((size - 1 - y) * size + x) * 4;
    const to = 40 + y * stride + x * 4;
    result[to] = rgba[from + 2]; result[to + 1] = rgba[from + 1]; result[to + 2] = rgba[from]; result[to + 3] = rgba[from + 3];
    if (!rgba[from + 3]) result[40 + pixels + y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return result;
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const directory = path.resolve(__dirname, '..', 'src', 'ui', 'assets');
  const source = nativeImage.createFromPath(path.join(directory, 'tetherspark-icon.png'));
  if (source.isEmpty()) throw new Error('The icon master could not be read.');
  const { width, height } = source.getSize();
  if (width !== height) throw new Error('The icon master must be square.');
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const pngs = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  // Small DIB frames support the Windows shell image list; keep the 256 px frame as PNG.
  const images = sizes.map((size, index) => size === 256 ? pngs[index] : bitmapFrame(pngs[index], size));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const at = 6 + index * 16;
    header[at] = size === 256 ? 0 : size;
    header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(images[index].length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  });
  fs.writeFileSync(path.join(directory, 'tetherspark.ico'), Buffer.concat([header, ...images]));
  fs.writeFileSync(path.join(directory, 'tetherspark-icon-256.png'), pngs.at(-1));
  console.log(`Exported TetherSpark Windows icon (${sizes.join(', ')} px).`);
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app.quit());

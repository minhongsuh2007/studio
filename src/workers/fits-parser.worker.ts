
/// <reference lib="webworker" />

self.onmessage = function(e: MessageEvent<ArrayBuffer>) {
  const arrayBuffer = e.data;
  try {
    const { header, dataOffset } = parseFITSHeader(arrayBuffer);
    if (!header.has('NAXIS1') || !header.has('NAXIS2') || !header.has('BITPIX')) {
        throw new Error('Essential FITS header keywords (NAXIS1, NAXIS2, BITPIX) are missing.');
    }
    const { width, height, pixels } = readFITSImage(arrayBuffer, header, dataOffset);
    const gray = normalizeToUint8(pixels);
    self.postMessage({ header: Object.fromEntries(header), width, height, gray });
  } catch (err: any) {
    self.postMessage({ error: err.message });
  }
};

function parseFITSHeader(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const cardSize = 80;
  const blockSize = 2880;
  let pos = 0;
  const header = new Map<string, string | number | boolean | null>();

  function parseCard(start: number): { key: string; value: any; isEnd: boolean } {
    const card = new TextDecoder('ascii').decode(bytes.subarray(start, start + cardSize));
    const key = card.slice(0, 8).trim();
    if (key === 'END') return { key, value: null, isEnd: true };
    if (!card.includes('=')) return { key, value: null, isEnd: false };

    const valueAndComment = card.slice(10).trim();
    const slashIndex = valueAndComment.indexOf('/');
    const valueString = slashIndex >= 0 ? valueAndComment.substring(0, slashIndex).trim() : valueAndComment;

    let value: any;
    if (valueString.startsWith("'")) {
      value = valueString.substring(1, valueString.lastIndexOf("'")).trim();
    } else if (valueString === 'T') {
      value = true;
    } else if (valueString === 'F') {
      value = false;
    } else {
      value = parseFloat(valueString);
      if (isNaN(value)) {
        value = valueString;
      }
    }
    return { key, value, isEnd: false };
  }

  let endFound = false;
  while (pos < bytes.length && !endFound) {
    for (let i = 0; i < blockSize; i += cardSize) {
      if (pos + i + cardSize > bytes.length) {
        endFound = true; // Avoid reading past the end of the file
        break;
      }
      const { key, value, isEnd } = parseCard(pos + i);
      if (isEnd) {
        endFound = true;
        break;
      }
      if (key) {
        header.set(key, value);
      }
    }
    if (!endFound) {
        pos += blockSize;
    }
  }

  // The data starts after the last header block that was read
  const dataOffset = pos + blockSize;

  if (!header.size) {
      throw new Error("Could not parse FITS header. The file may be corrupt or not a FITS file.");
  }

  return { header, dataOffset };
}

function readFITSImage(arrayBuffer: ArrayBuffer, header: Map<string, any>, dataOffset: number) {
  const dv = new DataView(arrayBuffer);
  const naxis = header.get('NAXIS');
  if (naxis < 1) throw new Error(`Invalid NAXIS value: ${naxis}`);
  if (naxis > 2) console.warn(`This FITS file has ${naxis} dimensions, but only the first 2 will be read.`);
  
  const width = header.get('NAXIS1');
  const height = header.get('NAXIS2') || 1; // Default to 1 for 1D images
  const bitpix = header.get('BITPIX');
  
  const bscale = header.get('BSCALE') ?? 1.0;
  const bzero  = header.get('BZERO')  ?? 0.0;
  
  const count = width * height;
  const pixels = new Float32Array(count);
  let offset = dataOffset;

  const readFunctions: Record<number, (offset: number) => number> = {
      8: (o) => dv.getUint8(o),
      16: (o) => dv.getInt16(o, false),
      32: (o) => dv.getInt32(o, false),
      [-32]: (o) => dv.getFloat32(o, false),
      [-64]: (o) => dv.getFloat64(o, false),
  };

  const readFunc = readFunctions[bitpix];
  if (!readFunc) {
      throw new Error(`Unsupported BITPIX value: ${bitpix}`);
  }

  const bytesPerPixel = Math.abs(bitpix) / 8;
  
  if (offset + count * bytesPerPixel > arrayBuffer.byteLength) {
      throw new Error('FITS data is truncated or header is incorrect.');
  }

  for (let i = 0; i < count; i++) {
    pixels[i] = readFunc(offset) * bscale + bzero;
    offset += bytesPerPixel;
  }

  return { width, height, pixels };
}

function normalizeToUint8(pixels: Float32Array): Uint8ClampedArray {
  let min = Infinity, max = -Infinity;
  for (const v of pixels) { 
    if (Number.isFinite(v)) {
      if (v < min) min = v; 
      if (v > max) max = v; 
    }
  }
  
  if (min === Infinity) { // All pixels were NaN/Infinity
    min = 0;
    max = 0;
  }

  const range = (max - min) || 1;
  const out = new Uint8ClampedArray(pixels.length);

  for (let i = 0; i < pixels.length; i++) {
    let v = (pixels[i] - min) / range;
    if (!Number.isFinite(v)) {
        v = 0; // Handle NaN/Infinity from pixels array by mapping to black
    }
    // Correctly scale and round the value before clamping
    out[i] = v * 255;
  }
  return out;
}

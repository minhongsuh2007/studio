
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

  function parseCard(start: number) {
    const card = new TextDecoder('ascii').decode(bytes.subarray(start, start + cardSize));
    const key = card.slice(0, 8).trim();
    if (key === '' || !card.includes('=')) return { key, value: null };

    const afterEq = card.slice(10).trim();
    let valueStr = afterEq;
    
    const slashIdx = afterEq.indexOf('/');
    if (slashIdx >= 0) {
      valueStr = afterEq.slice(0, slashIdx).trim();
    }

    let value: string | number | boolean | null;
    if (valueStr.startsWith("'")) {
      const endQuote = valueStr.lastIndexOf("'");
      value = valueStr.slice(1, endQuote >= 1 ? endQuote : undefined);
    } else if (valueStr === 'T' || valueStr === 'F') {
      value = (valueStr === 'T');
    } else {
      value = Number(valueStr);
      if (Number.isNaN(value)) value = valueStr; // Keep as string if not a valid number
    }
    return { key, value };
  }

  let foundEND = false;
  while (!foundEND) {
    if (pos >= bytes.length) {
      throw new Error("FITS header parsing error: Reached end of file before finding 'END' card.");
    }
    for (let i = 0; i < blockSize; i += cardSize) {
      const { key, value } = parseCard(pos + i);
      if (key === 'END') {
        foundEND = true;
        break;
      }
      if (key) {
          header.set(key, value);
      }
    }
    pos += blockSize;
  }
  return { header, dataOffset: pos };
}

function readFITSImage(arrayBuffer: ArrayBuffer, header: Map<string, any>, dataOffset: number) {
  const dv = new DataView(arrayBuffer);
  const naxis = header.get('NAXIS');
  if (naxis !== 2) throw new Error(`Only 2D images (NAXIS=2) are supported. This image has NAXIS=${naxis}.`);
  
  const width = header.get('NAXIS1');
  const height = header.get('NAXIS2');
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

  const range = (max - min) || 1;
  const out = new Uint8ClampedArray(pixels.length);

  for (let i = 0; i < pixels.length; i++) {
    let v = (pixels[i] - min) / range;
    if (!Number.isFinite(v)) v = 0; // Handle NaN/Infinity from pixels array
    out[i] = v * 255;
  }
  return out;
}

/// <reference lib="webworker" />

self.onmessage = function(e: MessageEvent<ArrayBuffer>) {
  const arrayBuffer = e.data;
  try {
    const { header, dataOffset } = parseFITSHeader(arrayBuffer);
    const { width, height, pixels } = readFITSImage(arrayBuffer, header, dataOffset);
    const gray = normalizeLog(pixels);
    self.postMessage({ header: Object.fromEntries(header), width, height, gray });
  } catch (err: any) {
    self.postMessage({ error: err.message });
  }
};

function parseFITSHeader(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const cardSize = 80, blockSize = 2880;
  let pos = 0;
  const header = new Map();
  function parseCard(start: number) {
    const card = new TextDecoder('ascii').decode(bytes.subarray(start, start + cardSize));
    const key = card.slice(0, 8).trim();
    if (!card.includes('=')) return { key, value: null };
    const afterEq = card.slice(10).trim();
    let valueStr = afterEq;
    const slashIdx = afterEq.indexOf('/');
    if (slashIdx >= 0) valueStr = afterEq.slice(0, slashIdx).trim();
    let value: any;
    if (valueStr.startsWith("'")) {
      const endQuote = valueStr.lastIndexOf("'");
      value = valueStr.slice(1, endQuote >= 1 ? endQuote : undefined);
    } else if (valueStr === 'T' || valueStr === 'F') {
      value = (valueStr === 'T');
    } else {
      value = Number(valueStr);
      if (Number.isNaN(value)) value = null;
    }
    return { key, value };
  }
  let foundEND = false;
  while (!foundEND) {
    for (let i = 0; i < blockSize; i += cardSize) {
      const cardData = parseCard(pos + i);
      if (cardData.key.length === 0) continue;
      if (cardData.key === 'END') { foundEND = true; break; }
      header.set(cardData.key, cardData.value);
    }
    pos += blockSize;
    if (pos >= bytes.length) break;
  }
  return { header, dataOffset: pos };
}

function readFITSImage(arrayBuffer: ArrayBuffer, header: Map<string, any>, dataOffset: number) {
  const dv = new DataView(arrayBuffer);
  const width = header.get('NAXIS1');
  const height = header.get('NAXIS2');
  const bitpix = header.get('BITPIX');
  const bscale = header.get('BSCALE') ?? 1.0;
  const bzero  = header.get('BZERO')  ?? 0.0;
  const count = width * height;
  const pixels = new Float32Array(count);
  let offset = dataOffset;

  if (bitpix === 16) {
    for (let i = 0; i < count; i++, offset += 2) {
      pixels[i] = dv.getUint16(offset, false) * bscale + bzero;
    }
  } else if (bitpix === 8) {
    for (let i = 0; i < count; i++, offset++) pixels[i] = dv.getUint8(offset) * bscale + bzero;
  } else if (bitpix === 32) {
    for (let i = 0; i < count; i++, offset += 4) pixels[i] = dv.getInt32(offset, false) * bscale + bzero;
  } else if (bitpix === -32) {
    for (let i = 0; i < count; i++, offset += 4) pixels[i] = dv.getFloat32(offset, false) * bscale + bzero;
  } else if (bitpix === -64) {
    for (let i = 0; i < count; i++, offset += 8) pixels[i] = dv.getFloat64(offset, false) * bscale + bzero;
  } else {
    throw new Error('지원하지 않는 BITPIX');
  }
  return { width, height, pixels };
}

function normalizeLog(pixels: Float32Array): Uint8ClampedArray {
  let min = Infinity, max = -Infinity;
  for (const v of pixels) {
    if (v > 0 && Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
     // If no valid positive pixels found, return a black image.
    return new Uint8ClampedArray(pixels.length);
  }

  const logMin = Math.log(min);
  const logMax = Math.log(max);
  const range = logMax - logMin;
  const out = new Uint8ClampedArray(pixels.length);

  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v > 0) {
      let lv = (Math.log(v) - logMin) / range;
      lv = Math.max(0, Math.min(1, lv)); // Clamp to [0, 1]
      out[i] = Math.round(lv * 255);
    } else {
      out[i] = 0; // Set non-positive values to black
    }
  }
  return out;
}

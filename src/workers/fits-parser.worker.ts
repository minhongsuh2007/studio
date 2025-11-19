/// <reference lib="webworker" />

self.onmessage = function (e: MessageEvent<ArrayBuffer>) {
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
  const cardSize = 80;
  const blockSize = 2880;
  let pos = 0;
  const header = new Map<string, any>();

  function parseCard(start: number) {
    const card = new TextDecoder('ascii').decode(bytes.subarray(start, start + cardSize));
    const key = card.slice(0, 8).trim();
    if (!card.includes('=')) {
      return { key, value: null };
    }
    const afterEq = card.slice(10).trim();
    let valueStr = afterEq;
    const slashIdx = afterEq.indexOf('/');
    if (slashIdx >= 0) {
      valueStr = afterEq.slice(0, slashIdx).trim();
    }
    let value: any;
    if (valueStr.startsWith("'")) {
      const endQuote = valueStr.lastIndexOf("'");
      value = valueStr.slice(1, endQuote >= 1 ? endQuote : undefined);
    } else if (valueStr === 'T' || valueStr === 'F') {
      value = (valueStr === 'T');
    } else {
      value = Number(valueStr);
      if (Number.isNaN(value)) {
        value = valueStr; 
      }
    }
    return { key, value };
  }

  let foundEND = false;
  while (!foundEND) {
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
    if (pos >= bytes.length) break;
  }
  
  const dataOffset = Math.ceil(pos / blockSize) * blockSize;
  
  return { header, dataOffset };
}


function readFITSImage(arrayBuffer: ArrayBuffer, header: Map<string, any>, dataOffset: number) {
  const dv = new DataView(arrayBuffer);
  const width = header.get('NAXIS1');
  const height = header.get('NAXIS2');
  const bitpix = header.get('BITPIX');
  const bscale = header.get('BSCALE') ?? 1.0;
  const bzero = header.get('BZERO') ?? 0.0;
  const count = width * height;
  const pixels = new Float32Array(count);
  let offset = dataOffset;

  let readLogic: string;
  if (bitpix === 16) {
    for (let i = 0; i < count; i++, offset += 2) pixels[i] = bzero + bscale * dv.getUint16(offset, false);
  } else if (bitpix === 8) {
    for (let i = 0; i < count; i++, offset++) pixels[i] = bzero + bscale * dv.getUint8(offset);
  } else if (bitpix === 32) {
    for (let i = 0; i < count; i++, offset += 4) pixels[i] = bzero + bscale * dv.getInt32(offset, false);
  } else if (bitpix === -32) {
    for (let i = 0; i < count; i++, offset += 4) pixels[i] = bzero + bscale * dv.getFloat32(offset, false);
  } else if (bitpix === -64) {
    for (let i = 0; i < count; i++, offset += 8) pixels[i] = bzero + bscale * dv.getFloat64(offset, false);
  } else {
    throw new Error(`Unsupported BITPIX: ${bitpix}`);
  }

  return { width, height, pixels };
}

// --- Normalization Functions ---

function normalizeLog(pixels: Float32Array): Uint8ClampedArray {
    let min = Infinity;
    let max = -Infinity;
    
    // First pass: find min and max of positive values
    for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (v > 0) {
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }

    if (!isFinite(min) || !isFinite(max)) {
      // Handle cases where all pixels are 0 or negative
      const out = new Uint8ClampedArray(pixels.length);
       for(let i=0; i<pixels.length; i++) {
            out[i] = 0;
       }
       return out;
    }
    
    const logMin = Math.log(min);
    const logMax = Math.log(max);
    const range = logMax - logMin;
    const gamma = 0.5; // less than 1 to brighten midtones
    
    const out = new Uint8ClampedArray(pixels.length);
    
    if (range <= 0) {
        // If range is 0, all positive values are the same. Map them to mid-gray.
        for(let i=0; i<pixels.length; i++) {
            out[i] = pixels[i] > 0 ? 128 : 0;
        }
        return out;
    }

    // Second pass: apply normalization
    for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (v <= 0) {
            out[i] = 0;
        } else {
            const lv = (Math.log(v) - logMin) / range;
            const gammaCorrected = Math.pow(lv, gamma);
            out[i] = Math.round(Math.max(0, Math.min(1, gammaCorrected)) * 255);
        }
    }
    return out;
}

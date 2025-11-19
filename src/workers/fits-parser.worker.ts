/// <reference lib="webworker" />

self.onmessage = function (e: MessageEvent<{ arrayBuffer: ArrayBuffer; mode: 'log' | 'sigma' | 'minmax' }>) {
  const { arrayBuffer, mode } = e.data;

  const logs: string[] = [];
  logs.push(`[FITS-WORKER] Worker received ${arrayBuffer.byteLength} bytes. Mode: ${mode}`);

  try {
    const { header, dataOffset } = parseFITSHeader(arrayBuffer, logs);
    const { width, height, pixels } = readFITSImage(arrayBuffer, header, dataOffset, logs);

    let gray: Uint8ClampedArray;
    gray = normalizeLog(pixels, logs);


    self.postMessage({ header: Object.fromEntries(header), width, height, gray, logs });
  } catch (err: any) {
    logs.push(`[FITS-WORKER-ERROR] ${err.message}`);
    self.postMessage({ error: err.message, logs });
  }
};

function parseFITSHeader(arrayBuffer: ArrayBuffer, logs: string[]) {
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
        value = valueStr; // Keep as string if not a valid number
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
  
  logs.push(`Header parsed. Found ${header.size} keywords. Data offset: ${dataOffset}`);
  ['BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'BSCALE', 'BZERO'].forEach(k => {
    if(header.has(k)) logs.push(`- ${k}: ${header.get(k)}`);
  });

  return { header, dataOffset };
}


function readFITSImage(arrayBuffer: ArrayBuffer, header: Map<string, any>, dataOffset: number, logs: string[]) {
  const dv = new DataView(arrayBuffer);
  const width = header.get('NAXIS1');
  const height = header.get('NAXIS2');
  const bitpix = header.get('BITPIX');
  const bscale = header.get('BSCALE') ?? 1.0;
  const bzero = header.get('BZERO') ?? 0.0;
  const count = width * height;
  const pixels = new Float32Array(count);
  let offset = dataOffset;

  let readLogic = "Unknown BITPIX";
  if (bitpix === 16) {
    if (bzero === 32768) {
      readLogic = `BITPIX 16 (Unsigned), BZERO ${bzero}`;
      for (let i = 0; i < count; i++, offset += 2) pixels[i] = dv.getUint16(offset, false) - bzero;
    } else {
      readLogic = `BITPIX 16 (Signed), BZERO ${bzero}`;
      for (let i = 0; i < count; i++, offset += 2) pixels[i] = bzero + bscale * dv.getInt16(offset, false);
    }
  } else if (bitpix === 8) {
    readLogic = "BITPIX 8";
    for (let i = 0; i < count; i++, offset++) pixels[i] = bzero + bscale * dv.getUint8(offset);
  } else if (bitpix === 32) {
    readLogic = "BITPIX 32 (Int)";
    for (let i = 0; i < count; i++, offset += 4) pixels[i] = bzero + bscale * dv.getInt32(offset, false);
  } else if (bitpix === -32) {
    readLogic = "BITPIX -32 (Float)";
    for (let i = 0; i < count; i++, offset += 4) pixels[i] = bzero + bscale * dv.getFloat32(offset, false);
  } else if (bitpix === -64) {
    readLogic = "BITPIX -64 (Double)";
    for (let i = 0; i < count; i++, offset += 8) pixels[i] = bzero + bscale * dv.getFloat64(offset, false);
  } else {
    throw new Error(`Unsupported BITPIX: ${bitpix}`);
  }

  logs.push(`[FITS-READ] Reading pixels using logic: ${readLogic}`);

  let min = Infinity, max = -Infinity, sum = 0, finiteCount = 0;
  for (const v of pixels) {
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      finiteCount++;
    }
  }
  logs.push(`Image data read. Total Pixels: ${count}. Finite Pixels: ${finiteCount}.`);
  logs.push(`Raw Pixel Stats: Min=${min}, Max=${max}, Avg=${finiteCount > 0 ? sum / finiteCount : 'N/A'}`);

  return { width, height, pixels };
}

// --- Normalization Functions ---

function normalizeLog(pixels: Float32Array, logs: string[]): Uint8ClampedArray {
    const logPixels = new Float32Array(pixels.length);
    let logMin = Infinity;
    let logMax = -Infinity;
    
    // Single pass to calculate log values and find min/max
    for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (Number.isFinite(v)) {
            // Ensure value is positive before taking log
            const logV = Math.log(Math.max(1, v)); 
            logPixels[i] = logV;
            if (logV < logMin) logMin = logV;
            if (logV > logMax) logMax = logV;
        } else {
            logPixels[i] = -Infinity; // Mark non-finite as smallest
        }
    }
    
    if (!Number.isFinite(logMin)) {
        logs.push(`[LogNormalize] No finite pixels found after log transform.`);
        return new Uint8ClampedArray(pixels.length);
    }
    
    const range = logMax - logMin;
    logs.push(`[LogNormalize] Log-scaled range: [${logMin.toFixed(2)}, ${logMax.toFixed(2)}], Range=${range.toFixed(2)}`);

    const out = new Uint8ClampedArray(pixels.length);
    if (range <= 0) {
        logs.push(`[LogNormalize-WARN] Log range is <= 0. Returning flat image.`);
        // If range is 0, all values are the same, return mid-gray
        const midValue = 128;
        for (let i = 0; i < pixels.length; i++) {
             if(Number.isFinite(logPixels[i])) out[i] = midValue;
        }
        return out;
    }

    for (let i = 0; i < logPixels.length; i++) {
        const lv = logPixels[i];
        if (Number.isFinite(lv)) {
            let normalized = (lv - logMin) / range;
            out[i] = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
        } else {
            out[i] = 0;
        }
    }
    return out;
}

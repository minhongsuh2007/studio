/// <reference lib="webworker" />

self.onmessage = function (e: MessageEvent<{ arrayBuffer: ArrayBuffer; mode: 'log' | 'sigma' | 'minmax' }>) {
  const { arrayBuffer, mode } = e.data;

  const logs: string[] = [];
  logs.push(`[FITS-WORKER] Worker received ${arrayBuffer.byteLength} bytes. Mode: ${mode}`);

  try {
    const { header, dataOffset } = parseFITSHeader(arrayBuffer, logs);
    const { width, height, pixels } = readFITSImage(arrayBuffer, header, dataOffset, logs);

    let gray: Uint8ClampedArray;
    if (mode === 'log') {
      gray = normalizeLog(pixels, logs);
    } else {
      // Fallback to sigma as it's generally good.
      gray = normalizeSigma(pixels, logs, 3);
    }

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

function normalizeSigma(pixels: Float32Array, logs: string[], sigma: number = 3): Uint8ClampedArray {
  const finitePixels = Array.from(pixels).filter(Number.isFinite);
  if (finitePixels.length === 0) return new Uint8ClampedArray(pixels.length);

  const sum = finitePixels.reduce((a, b) => a + b, 0);
  const mean = sum / finitePixels.length;

  const variance = finitePixels.reduce((a, b) => a + (b - mean) ** 2, 0) / finitePixels.length;
  const std = Math.sqrt(variance);
  logs.push(`[Sigma] Normalizing with Mean=${mean.toFixed(2)}, StdDev=${std.toFixed(2)}`);

  const min = mean - sigma * std;
  const max = mean + sigma * std;
  const range = (max - min) || 1;
  logs.push(`[Sigma] Clipping to range [${min.toFixed(2)}, ${max.toFixed(2)}], Range=${range.toFixed(2)}`);

  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    let v = (pixels[i] - min) / range;
    v = Math.max(0, Math.min(1, v));
    out[i] = Math.round(v * 255);
  }
  return out;
}

function normalizeLog(pixels: Float32Array, logs: string[]): Uint8ClampedArray {
    let min = Infinity;
    let max = -Infinity;
    
    // Find the true min and max of the finite pixel data
    for (const v of pixels) {
        if (Number.isFinite(v)) {
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    
    if (!Number.isFinite(min)) {
        logs.push(`[LogNormalize] No finite pixels found.`);
        return new Uint8ClampedArray(pixels.length);
    }
    
    logs.push(`[LogNormalize] Full data range: Min=${min.toFixed(2)}, Max=${max.toFixed(2)}`);

    // To prevent log(0) or log(negative), we shift the entire dataset so the minimum is a small positive number.
    const shift = -min + 1; 
    const shiftedMin = 1;
    const shiftedMax = max + shift;

    const logMin = Math.log(shiftedMin);
    const logMax = Math.log(shiftedMax);
    const range = logMax - logMin;

    if (range <= 0) {
        logs.push(`[LogNormalize-WARN] Log range is <= 0. Returning linear scale.`);
        return normalizeMinMax(pixels, logs);
    }

    logs.push(`[LogNormalize] Applying log scale to shifted range [${shiftedMin.toFixed(2)}, ${shiftedMax.toFixed(2)}]`);

    const out = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (!Number.isFinite(v)) {
            out[i] = 0;
            continue;
        }
        
        const shiftedValue = v + shift;
        
        let lv = (Math.log(shiftedValue) - logMin) / range;
        
        // Clamp to ensure value is between 0 and 1, just in case of float precision issues
        lv = Math.max(0, Math.min(1, lv));

        out[i] = Math.round(lv * 255);
    }

    return out;
}


function normalizeMinMax(pixels: Float32Array, logs: string[]): Uint8ClampedArray {
  let min = Infinity, max = -Infinity;
  for (const v of pixels) { if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; } }
  
  if (!Number.isFinite(min)) {
    logs.push('[MinMax] No finite pixels to determine range.');
    return new Uint8ClampedArray(pixels.length);
  }

  const range = (max - min) || 1;
  logs.push(`[MinMax] Normalizing with Min=${min}, Max=${max}, Range=${range}`);
  const out = new Uint8ClampedArray(pixels.length);

  for (let i = 0; i < pixels.length; i++) {
    let v = (pixels[i] - min) / range;
    if (!Number.isFinite(v)) v = 0;
    out[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  return out;
}

/// <reference lib="webworker" />

self.onmessage = function(e: MessageEvent<{ arrayBuffer: ArrayBuffer; mode: 'sigma' | 'log' | 'minmax' }>) {
  const { arrayBuffer, mode } = e.data;
  const logs: string[] = [];
  logs.push(`[FITS-WORKER] Worker received ${arrayBuffer.byteLength} bytes. Mode: ${mode}`);
  try {
    const { header, dataOffset } = parseFITSHeader(arrayBuffer, logs);
    if (!header.has('NAXIS1') || !header.has('NAXIS2') || !header.has('BITPIX')) {
        throw new Error('Essential FITS header keywords (NAXIS1, NAXIS2, BITPIX) are missing.');
    }
    const { width, height, pixels } = readFITSImage(arrayBuffer, header, dataOffset, logs);
    
    let gray;
    if (mode === 'sigma') {
        gray = normalizeSigma(pixels, logs);
    } else if (mode === 'minmax') {
        gray = normalizeMinMax(pixels, logs);
    } else { // 'log' is the default
        gray = normalizeLog(pixels, logs);
    }

    self.postMessage({ header: Object.fromEntries(header), width, height, gray, logs });
  } catch (err: any) {
    logs.push(`[FITS-CRITICAL] ${err.message}`);
    self.postMessage({ error: err.message, logs });
  }
};

function parseFITSHeader(arrayBuffer: ArrayBuffer, logs: string[]): { header: Map<string, any>, dataOffset: number } {
  const bytes = new Uint8Array(arrayBuffer);
  const cardSize = 80;
  const blockSize = 2880;
  let pos = 0;
  const header = new Map<string, any>();

  function parseCard(start: number): { key: string; value: any; } | null {
    const card = new TextDecoder('ascii').decode(bytes.subarray(start, start + cardSize));
    const key = card.slice(0, 8).trim();
    if (key === '') return null; // Skip blank cards
    if (key === 'END') return { key: 'END', value: null };
    
    if (!card.includes('=')) {
        return { key, value: null };
    }

    const valueAndComment = card.slice(10).trim();
    const slashIndex = valueAndComment.indexOf('/');
    const valueStr = (slashIndex > -1 ? valueAndComment.substring(0, slashIndex) : valueAndComment).trim();

    let value: any;
    if (valueStr.startsWith("'")) {
        value = valueStr.substring(1, valueStr.lastIndexOf("'")).trim();
    } else if (valueStr === 'T') {
        value = true;
    } else if (valueStr === 'F') {
        value = false;
    } else {
        value = Number(valueStr);
        if (isNaN(value)) {
            value = valueStr !== '' ? valueStr : null;
        }
    }
    return { key, value };
  }

  let foundEND = false;
  let blockCount = 0;
  while (pos < bytes.length && !foundEND) {
      blockCount++;
      for (let i = 0; i < blockSize; i += cardSize) {
          if (pos + i + cardSize > bytes.length) {
              logs.push(`[FITS-WARN] Reached end of file while reading header block ${blockCount}.`);
              foundEND = true; 
              break;
          }
          const cardData = parseCard(pos + i);
          if (cardData) {
              if (cardData.key === 'END') {
                  foundEND = true;
                  break;
              }
              header.set(cardData.key, cardData.value);
          }
      }
      pos += blockSize;
      if (!foundEND && pos >= bytes.length) {
        logs.push(`[FITS-WARN] Header seems to be missing END card. Reached end of file.`);
        break;
      }
  }
  
  logs.push(`[FITS-WORKER] Header parsed. Found ${header.size} keywords in ${blockCount} block(s). Data offset: ${pos}`);
  header.forEach((value, key) => {
    if (['NAXIS', 'NAXIS1', 'NAXIS2', 'BITPIX', 'BSCALE', 'BZERO'].includes(key)) {
      logs.push(`  - ${key}: ${value}`);
    }
  });

  return { header, dataOffset: pos };
}


function readFITSImage(arrayBuffer: ArrayBuffer, header: Map<string, any>, dataOffset: number, logs: string[]): { width: number, height: number, pixels: Float32Array } {
  const dv = new DataView(arrayBuffer);
  const naxis = header.get('NAXIS') || 0;
  if (naxis < 2) throw new Error(`Invalid NAXIS value: ${naxis}. Only 2D images are supported.`);
  
  const width = header.get('NAXIS1');
  const height = header.get('NAXIS2');
  const bitpix = header.get('BITPIX');
  
  const bscale = header.get('BSCALE') ?? 1.0;
  const bzero  = header.get('BZERO')  ?? 0.0;
  
  const count = width * height;
  const pixels = new Float32Array(count);
  let offset = dataOffset;

  const bytesPerPixel = Math.abs(bitpix) / 8;

  if (offset + count * bytesPerPixel > arrayBuffer.byteLength) {
      throw new Error(`FITS data is truncated. Header indicates ${count * bytesPerPixel} bytes of data after offset ${offset}, but buffer has only ${arrayBuffer.byteLength} bytes.`);
  }

  logs.push(`[FITS-WORKER] Reading pixels with BITPIX: ${bitpix}, BZERO: ${bzero}, BSCALE: ${bscale}`);
  let readLogicUsed = 'Unknown';
  
  // FITS Standard: True Value = BZERO + BSCALE * File Value
  switch (bitpix) {
      case 8:
          readLogicUsed = 'BITPIX 8 (Uint8)';
          for (let i = 0; i < count; i++, offset++) pixels[i] = bzero + bscale * dv.getUint8(offset);
          break;
      case 16:
          readLogicUsed = 'BITPIX 16 (Uint16)';
          for (let i = 0; i < count; i++, offset += 2) pixels[i] = bzero + bscale * dv.getUint16(offset, false);
          break;
      case 32:
          readLogicUsed = 'BITPIX 32 (Int32)';
          for (let i = 0; i < count; i++, offset += 4) pixels[i] = bzero + bscale * dv.getInt32(offset, false);
          break;
      case -32:
          readLogicUsed = 'BITPIX -32 (Float32)';
          for (let i = 0; i < count; i++, offset += 4) pixels[i] = bzero + bscale * dv.getFloat32(offset, false);
          break;
      case -64:
          readLogicUsed = 'BITPIX -64 (Float64)';
          for (let i = 0; i < count; i++, offset += 8) pixels[i] = bzero + bscale * dv.getFloat64(offset, false);
          break;
      default: throw new Error(`Unsupported BITPIX value: ${bitpix}`);
  }
  logs.push(`[FITS-WORKER] Read logic used: ${readLogicUsed}.`);
  
  let min = Infinity, max = -Infinity, sum = 0, finiteCount = 0;
  for (const v of pixels) {
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      finiteCount++;
    }
  }
  logs.push(`[FITS-WORKER] Image data read. Total Pixels: ${count}. Finite Pixels: ${finiteCount}.`);
  logs.push(`[FITS-WORKER] Raw Pixel Stats: Min=${min}, Max=${max}, Avg=${sum / finiteCount}`);

  return { width, height, pixels };
}

function normalizeMinMax(pixels: Float32Array, logs: string[]): Uint8ClampedArray {
  let min = Infinity, max = -Infinity;
  for (const v of pixels) { if (Number.isFinite(v)) { if(v<min)min=v; if(v>max)max=v; } }
  const range = (max - min) || 1;
  logs.push(`[FITS-NORMALIZE] MinMax: Normalizing with Min=${min}, Max=${max}, Range=${range}`);
  const out = new Uint8ClampedArray(pixels.length);
  for (let i=0;i<pixels.length;i++) {
    let v = (pixels[i] - min) / range;
    if (!Number.isFinite(v)) v = 0;
    out[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  return out;
}

function normalizeSigma(pixels: Float32Array, logs: string[], sigma = 3.0): Uint8ClampedArray {
  let sum=0, finiteCount=0;
  for(const v of pixels){if(Number.isFinite(v)){sum+=v;finiteCount++;}}
  if (finiteCount === 0) return new Uint8ClampedArray(pixels.length);

  const mean=sum/finiteCount;
  let varSum=0;
  for(const v of pixels){if(Number.isFinite(v)){varSum+=(v-mean)**2;}}
  const std=Math.sqrt(varSum/finiteCount) || 1;
  
  const clipMin=mean-sigma*std;
  const clipMax=mean+sigma*std;
  const range=(clipMax-clipMin)||1;

  logs.push(`[FITS-NORMALIZE] Sigma: Normalizing with Mean=${mean.toFixed(2)}, StdDev=${std.toFixed(2)}`);
  logs.push(`[FITS-NORMALIZE] Sigma: Clipping to range [${clipMin.toFixed(2)}, ${clipMax.toFixed(2)}], Range=${range.toFixed(2)}`);

  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i++){
    let v=(pixels[i]-clipMin)/range;
    v=Math.max(0,Math.min(1,v));
    if (!Number.isFinite(v)) v = 0;
    out[i]=Math.round(v*255);
  }
  return out;
}

function normalizeLog(pixels: Float32Array, logs: string[]): Uint8ClampedArray {
    const sortedPixels = Float32Array.from(pixels).filter(p => Number.isFinite(p)).sort((a, b) => a - b);
    if (sortedPixels.length === 0) {
        logs.push('[FITS-NORMALIZE] Log: No finite pixels found.');
        return new Uint8ClampedArray(pixels.length);
    }
    
    // 1. Estimate background using median
    const median = sortedPixels[Math.floor(sortedPixels.length / 2)];

    // 2. Estimate noise using Median Absolute Deviation (MAD)
    const deviations = sortedPixels.map(p => Math.abs(p - median));
    deviations.sort((a,b) => a-b);
    const mad = deviations[Math.floor(deviations.length / 2)];
    const stdDev = mad * 1.4826; // Conversion factor for Gaussian distribution

    // 3. Set black point and white point
    const blackPoint = median - 0.5 * stdDev;
    let whitePoint = Infinity; // We will find this from the data

    // Find the actual max value for a sensible white point
    const dataMax = sortedPixels[sortedPixels.length - 1];
    whitePoint = dataMax;

    logs.push(`[FITS-NORMALIZE] Log: Median=${median.toFixed(2)}, MAD=${mad.toFixed(2)}, Est. StdDev=${stdDev.toFixed(2)}`);
    logs.push(`[FITS-NORMALIZE] Log: Setting Black Point=${blackPoint.toFixed(2)}, White Point=${whitePoint.toFixed(2)}`);

    const range = whitePoint - blackPoint;
    if (range <= 0) {
        logs.push('[FITS-WARN] Log: Range is zero or negative. Falling back to MinMax normalization.');
        return normalizeMinMax(pixels, logs);
    }

    const logRange = Math.log(range + 1);
    const out = new Uint8ClampedArray(pixels.length);

    for (let i = 0; i < pixels.length; i++) {
        let v = pixels[i];
        if (!Number.isFinite(v)) {
            out[i] = 0;
            continue;
        }
        
        let scaledV = (v - blackPoint);
        if (scaledV <= 0) {
            out[i] = 0;
        } else {
            // Apply a logarithmic curve to the scaled value
            let logV = Math.log(scaledV + 1) / logRange;
            out[i] = Math.round(Math.max(0, Math.min(1, logV)) * 255);
        }
    }
    
    return out;
}

/// <reference lib="webworker" />

self.onmessage = function(e: MessageEvent<{ arrayBuffer: ArrayBuffer; mode: 'sigma' | 'log' | 'minmax' }>) {
  const { arrayBuffer, mode } = e.data;
  const logs: string[] = [];
  logs.push(`Worker received ${arrayBuffer.byteLength} bytes. Mode: ${mode}`);
  try {
    const { header, dataOffset } = parseFITSHeader(arrayBuffer, logs);
    if (!header.has('NAXIS1') || !header.has('NAXIS2') || !header.has('BITPIX')) {
        throw new Error('Essential FITS header keywords (NAXIS1, NAXIS2, BITPIX) are missing.');
    }
    const { width, height, pixels } = readFITSImage(arrayBuffer, header, dataOffset, logs);
    
    let gray;
    if (mode === 'sigma') gray = normalizeSigma(pixels, logs, 3);
    else if (mode === 'log') gray = normalizeLog(pixels, logs);
    else gray = normalizeMinMax(pixels, logs);

    self.postMessage({ header: Object.fromEntries(header), width, height, gray, logs });
  } catch (err: any) {
    logs.push(`[CRITICAL] ${err.message}`);
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
    if (key === '') return null;
    if (key === 'END') return { key: 'END', value: null };
    
    if (card[8] !== '=' || card[9] !== ' ') {
      header.set(key, card.slice(9).trim());
      return null;
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
            value = valueStr;
        }
    }
    return { key, value };
  }

  let foundEND = false;
  while (pos < bytes.length && !foundEND) {
      for (let i = 0; i < blockSize; i += cardSize) {
          if (pos + i + cardSize > bytes.length) {
              foundEND = true; // Avoid reading past buffer
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
      if (foundEND) {
        // The data unit starts after the header block containing END
        pos += blockSize;
        break;
      }
      pos += blockSize;
  }
  
  if (!foundEND) {
    throw new Error("FITS header 'END' keyword not found or header is truncated.");
  }
  
  logs.push(`Header parsed. Found ${header.size} keywords. Calculated data offset: ${pos}`);
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

  logs.push(`Reading pixels with BITPIX: ${bitpix}, BZERO: ${bzero}, BSCALE: ${bscale}`);

  switch (bitpix) {
      case 8:
          logs.push('Using BITPIX 8 logic (Uint8).');
          for (let i = 0; i < count; i++, offset++) pixels[i] = bzero + bscale * dv.getUint8(offset);
          break;
      case 16:
          if (bzero === 32768 && bscale === 1) {
              logs.push('Using BITPIX 16 logic for unsigned integers (BZERO=32768).');
              for (let i = 0; i < count; i++, offset += 2) pixels[i] = dv.getUint16(offset, false) - bzero;
          } else {
              logs.push('Using BITPIX 16 logic for signed integers.');
              for (let i = 0; i < count; i++, offset += 2) pixels[i] = bzero + bscale * dv.getInt16(offset, false);
          }
          break;
      case 32:
          logs.push('Using BITPIX 32 logic (Int32).');
          for (let i = 0; i < count; i++, offset += 4) pixels[i] = bzero + bscale * dv.getInt32(offset, false);
          break;
      case -32:
          logs.push('Using BITPIX -32 logic (Float32).');
          for (let i = 0; i < count; i++, offset += 4) pixels[i] = bzero + bscale * dv.getFloat32(offset, false);
          break;
      case -64:
          logs.push('Using BITPIX -64 logic (Float64).');
          for (let i = 0; i < count; i++, offset += 8) pixels[i] = bzero + bscale * dv.getFloat64(offset, false);
          break;
      default: throw new Error(`Unsupported BITPIX value: ${bitpix}`);
  }
  
  let min = Infinity, max = -Infinity, sum = 0, finiteCount = 0;
  for (const v of pixels) {
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      finiteCount++;
    }
  }
  logs.push(`Image data read complete. Total Pixels: ${count}. Finite Pixels: ${finiteCount}.`);
  logs.push(`Raw Pixel Stats after BZERO/BSCALE: Min=${min}, Max=${max}, Avg=${sum / finiteCount}`);

  return { width, height, pixels };
}

function normalizeMinMax(pixels: Float32Array, logs: string[]): Uint8ClampedArray {
  let min = Infinity, max = -Infinity;
  for (const v of pixels) { if (Number.isFinite(v)) { if(v<min)min=v; if(v>max)max=v; } }
  const range = (max - min) || 1;
  logs.push(`[MinMax] Normalizing with Min=${min}, Max=${max}, Range=${range}`);
  const out = new Uint8ClampedArray(pixels.length);
  for (let i=0;i<pixels.length;i++) {
    let v = (pixels[i] - min) / range;
    if (!Number.isFinite(v)) v = 0;
    out[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  return out;
}

function normalizeSigma(pixels: Float32Array, logs: string[], sigma = 3): Uint8ClampedArray {
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

  logs.push(`[Sigma] Normalizing with Mean=${mean.toFixed(2)}, StdDev=${std.toFixed(2)}`);
  logs.push(`[Sigma] Clipping to range [${clipMin.toFixed(2)}, ${clipMax.toFixed(2)}], Range=${range.toFixed(2)}`);

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
  let min=Infinity,max=-Infinity;
  for(const v of pixels){if(v>0 && Number.isFinite(v)){if(v<min)min=v;if(v>max)max=v;}}
  if (!Number.isFinite(min)) {
    logs.push('[Log] No positive finite pixels found for log scale. Returning black image.');
    return new Uint8ClampedArray(pixels.length);
  }
  const logMin=Math.log(min), logMax=Math.log(max), range=logMax-logMin || 1;
  logs.push(`[Log] Normalizing with positive Min=${min}, Max=${max}. Log Range=[${logMin.toFixed(2)}, ${logMax.toFixed(2)}]`);
  
  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i++){
    let v=pixels[i];
    if(v<=0 || !Number.isFinite(v)){out[i]=0;continue;}
    let lv=(Math.log(v)-logMin)/range;
    lv=Math.max(0,Math.min(1,lv));
    out[i]=Math.round(lv*255);
  }
  return out;
}

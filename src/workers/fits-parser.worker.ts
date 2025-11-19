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

  function parseCard(start: number): { key: string; value: any; } {
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
      if (Number.isNaN(value)) value = valueStr;
    }
    return { key, value };
  }

  let foundEND = false;
  while (!foundEND && pos < bytes.length) {
    for (let i = 0; i < blockSize; i += cardSize) {
      if (pos + i + cardSize > bytes.length) {
        throw new Error("Header parsing error: reached end of file unexpectedly.");
      }
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
  
  if (!foundEND) {
    throw new Error("FITS header 'END' keyword not found.");
  }
  
  logs.push(`Header parsed. Found ${header.size} keywords. Data offset: ${pos}`);
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
  if (naxis < 1) throw new Error(`Invalid NAXIS value: ${naxis}`);
  
  const width = header.get('NAXIS1');
  const height = naxis > 1 ? header.get('NAXIS2') : 1;
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
      throw new Error(`FITS data is truncated. Header indicates ${count * bytesPerPixel} bytes of data after offset ${offset}, but buffer has only ${arrayBuffer.byteLength} bytes.`);
  }

  for (let i = 0; i < count; i++) {
    pixels[i] = readFunc(offset) * bscale + bzero;
    offset += bytesPerPixel;
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
  logs.push(`Image data read. Total Pixels: ${count}. Finite Pixels: ${finiteCount}.`);
  logs.push(`Raw Pixel Stats: Min=${min}, Max=${max}, Avg=${sum / finiteCount}`);

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
  const std=Math.sqrt(varSum/finiteCount);
  
  const clipMin=mean-sigma*std;
  const clipMax=mean+sigma*std;
  const range=(clipMax-clipMin)||1;

  logs.push(`[Sigma] Normalizing with Mean=${mean.toFixed(2)}, StdDev=${std.toFixed(2)}`);
  logs.push(`[Sigma] Clipping to range [${clipMin.toFixed(2)}, ${clipMax.toFixed(2)}], Range=${range.toFixed(2)}`);

  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i++){
    let v=(pixels[i]-clipMin)/range;
    v=Math.max(0,Math.min(1,v));
    out[i]=Math.round(v*255);
  }
  return out;
}

function normalizeLog(pixels: Float32Array, logs: string[]): Uint8ClampedArray {
  let min=Infinity,max=-Infinity;
  for(const v of pixels){if(v>0 && Number.isFinite(v)){if(v<min)min=v;if(v>max)max=v;}}
  if (!Number.isFinite(min)) {
    logs.push('[Log] No positive finite pixels found. Returning black image.');
    return new Uint8ClampedArray(pixels.length);
  }
  const logMin=Math.log(min), logMax=Math.log(max), range=logMax-logMin || 1;
  logs.push(`[Log] Normalizing with Min=${min}, Max=${max}. Log Range=[${logMin.toFixed(2)}, ${logMax.toFixed(2)}]`);
  
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

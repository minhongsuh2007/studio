/// <reference lib="webworker" />

self.onmessage = function(e: MessageEvent<{ arrayBuffer: ArrayBuffer; mode: 'sigma' | 'log' | 'minmax' }>) {
  const { arrayBuffer, mode } = e.data;
  try {
    const { header, dataOffset } = parseFITSHeader(arrayBuffer);
    if (!header.has('NAXIS1') || !header.has('NAXIS2') || !header.has('BITPIX')) {
        throw new Error('Essential FITS header keywords (NAXIS1, NAXIS2, BITPIX) are missing.');
    }
    const { width, height, pixels } = readFITSImage(arrayBuffer, header, dataOffset);
    
    let gray;
    if (mode === 'sigma') gray = normalizeSigma(pixels, 3);
    else if (mode === 'log') gray = normalizeLog(pixels);
    else gray = normalizeMinMax(pixels);

    self.postMessage({ header: Object.fromEntries(header), width, height, gray });
  } catch (err: any) {
    self.postMessage({ error: err.message });
  }
};

function parseFITSHeader(arrayBuffer: ArrayBuffer): { header: Map<string, any>, dataOffset: number } {
  const bytes = new Uint8Array(arrayBuffer);
  const cardSize = 80, blockSize = 2880;
  let pos = 0;
  const header = new Map<string, any>();

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
        endFound = true; 
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

  const dataOffset = pos + blockSize;

  if (!header.size) {
      throw new Error("Could not parse FITS header. The file may be corrupt or not a FITS file.");
  }

  return { header, dataOffset };
}


function readFITSImage(arrayBuffer: ArrayBuffer, header: Map<string, any>, dataOffset: number): { width: number, height: number, pixels: Float32Array } {
  const dv = new DataView(arrayBuffer);
  const naxis = header.get('NAXIS');
  if (naxis < 1) throw new Error(`Invalid NAXIS value: ${naxis}`);
  if (naxis > 2) console.warn(`This FITS file has ${naxis} dimensions, but only the first 2 will be read.`);
  
  const width = header.get('NAXIS1');
  const height = header.get('NAXIS2') || 1;
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

function normalizeMinMax(pixels: Float32Array): Uint8ClampedArray {
  let min = Infinity, max = -Infinity;
  for (const v of pixels) { if (Number.isFinite(v)) { if(v<min)min=v; if(v>max)max=v; } }
  const range = (max - min) || 1;
  const out = new Uint8ClampedArray(pixels.length);
  for (let i=0;i<pixels.length;i++) {
    let v=(pixels[i]-min)/range;
    if (!Number.isFinite(v)) v=0;
    out[i]=Math.round(Math.max(0,Math.min(1,v))*255);
  }
  return out;
}

function normalizeSigma(pixels: Float32Array, sigma=3): Uint8ClampedArray {
  let sum=0,cnt=0;
  for(const v of pixels){if(Number.isFinite(v)){sum+=v;cnt++;}}
  const mean=sum/cnt;
  let varSum=0;
  for(const v of pixels){if(Number.isFinite(v)){varSum+=(v-mean)**2;}}
  const std=Math.sqrt(varSum/cnt);
  const min=mean-sigma*std, max=mean+sigma*std;
  const range=(max-min)||1;
  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i++){
    let v=(pixels[i]-min)/range;
    v=Math.max(0,Math.min(1,v));
    out[i]=Math.round(v*255);
  }
  return out;
}

function normalizeLog(pixels: Float32Array): Uint8ClampedArray {
  let min=Infinity,max=-Infinity;
  for(const v of pixels){if(v>0){if(v<min)min=v;if(v>max)max=v;}}
  const logMin=Math.log(min), logMax=Math.log(max), range=logMax-logMin;
  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i++){
    let v=pixels[i];
    if(v<=0){out[i]=0;continue;}
    let lv=(Math.log(v)-logMin)/range;
    lv=Math.max(0,Math.min(1,lv));
    out[i]=Math.round(lv*255);
  }
  return out;
}

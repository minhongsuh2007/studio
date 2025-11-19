/// <reference lib="webworker" />

self.onmessage = function (e: MessageEvent<ArrayBuffer>) {
  const arrayBuffer = e.data;
  try {
    const { header, dataOffset } = parseFITSHeader(arrayBuffer);
    const { width, height, pixels } = readFITSImage(arrayBuffer, header, dataOffset);
    const gray = arcsinhStretch(pixels); // Use the new arcsinh stretch function
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

/**
 * A robust normalization function for FITS data using arcsinh stretching.
 * This preserves faint details while preventing bright stars from saturating.
 */
function arcsinhStretch(pixels: Float32Array): Uint8ClampedArray {
    const out = new Uint8ClampedArray(pixels.length);
    if (pixels.length === 0) return out;

    // --- Step 1: Estimate background and find the median of the data ---
    // A subsample is used for performance on very large images
    const sampleSize = 10000;
    const sample = new Float32Array(sampleSize);
    if (pixels.length > sampleSize) {
        for (let i = 0; i < sampleSize; i++) {
            sample[i] = pixels[Math.floor(Math.random() * pixels.length)];
        }
    } else {
        // If the image is smaller than the sample size, just use a copy
        for(let i=0; i<pixels.length; i++) sample[i] = pixels[i];
    }
    sample.sort();
    const median = sample[Math.floor(sample.length / 2)];

    // --- Step 2: Determine the stretch intensity (non-linearity factor) ---
    // This is a common value in astronomical imaging, adjust as needed.
    const stretch = 200; 

    // --- Step 3: Apply the arcsinh transformation ---
    const transformedPixels = new Float32Array(pixels.length);
    for (let i = 0; i < pixels.length; i++) {
        // Shift data so background is near zero, then apply stretch
        const shiftedValue = pixels[i] - median;
        transformedPixels[i] = Math.asinh(shiftedValue / stretch);
    }
    
    // --- Step 4: Find min/max of the *transformed* data for scaling ---
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < transformedPixels.length; i++) {
        const v = transformedPixels[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }

    const range = max - min;
    if (range <= 0) {
        // This case happens if the image is flat. Return a mid-gray image.
        out.fill(128);
        return out;
    }

    // --- Step 5: Scale the transformed data to the 0-255 range ---
    for (let i = 0; i < pixels.length; i++) {
        const v = transformedPixels[i];
        out[i] = Math.round(((v - min) / range) * 255);
    }

    return out;
}

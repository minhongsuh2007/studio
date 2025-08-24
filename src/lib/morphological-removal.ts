
'use client';

// Utility helpers
function clamp255(x: number): number { return x < 0 ? 0 : x > 255 ? 255 : x; }
function rgbToL(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b; // 0..255
}

function makeCircularOffsets(radius: number): Int16Array[] {
  const R = Math.max(1, Math.floor(radius));
  const rows: Int16Array[] = [];
  for (let dy = -R; dy <= R; dy++) {
    const w = Math.floor(Math.sqrt(R * R - dy * dy));
    const row: number[] = [];
    for (let dx = -w; dx <= w; dx++) row.push(dx);
    rows.push(Int16Array.from(row));
  }
  return rows;
}

function erodeGray(src: Uint8ClampedArray, width: number, height: number, circleRows: Int16Array[]): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(width * height);
  const R = Math.floor(circleRows.length / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let minVal = 255;
      for (let r = -R; r <= R; r++) {
        const yy = y + r;
        if (yy < 0 || yy >= height) continue;
        const row = circleRows[r + R];
        for (let i = 0; i < row.length; i++) {
          const dx = row[i];
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const v = src[yy * width + xx];
          if (v < minVal) minVal = v;
        }
      }
      dst[y * width + x] = minVal;
    }
  }
  return dst;
}

function dilateGray(src: Uint8ClampedArray, width: number, height: number, circleRows: Int16Array[]): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(width * height);
  const R = Math.floor(circleRows.length / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maxVal = 0;
      for (let r = -R; r <= R; r++) {
        const yy = y + r;
        if (yy < 0 || yy >= height) continue;
        const row = circleRows[r + R];
        for (let i = 0; i < row.length; i++) {
          const dx = row[i];
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const v = src[yy * width + xx];
          if (v > maxVal) maxVal = v;
        }
      }
      dst[y * width + x] = maxVal;
    }
  }
  return dst;
}

function openingGray(src: Uint8ClampedArray, width: number, height: number, circleRows: Int16Array[]): Uint8ClampedArray {
  return dilateGray(erodeGray(src, width, height, circleRows), width, height, circleRows);
}

/**
 * Applies morphological opening to an image to reduce star brightness.
 * @param imageData The original image data.
 * @param radius The radius for the morphological operation.
 * @returns The processed image data with stars reduced.
 */
export function applyMorphologicalOpening(imageData: ImageData, radius: number): ImageData {
    const { width, height, data: src } = imageData;
    const circleRows = makeCircularOffsets(radius);

    // 1. Convert to Luminance (Grayscale)
    const L = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      L[p] = clamp255(rgbToL(src[i], src[i + 1], src[i + 2]));
    }

    // 2. Apply Morphological Opening
    const Lopen = openingGray(L, width, height, circleRows);

    // 3. Create new image data by scaling original RGB by L_open / L
    const dstData = new Uint8ClampedArray(src.length);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      const scale = L[p] > 0 ? (Lopen[p] / L[p]) : 1;
      dstData[i] = clamp255(src[i] * scale);
      dstData[i + 1] = clamp255(src[i + 1] * scale);
      dstData[i + 2] = clamp255(src[i + 2] * scale);
      dstData[i + 3] = src[i + 3];
    }
    
    return new ImageData(dstData, width, height);
}

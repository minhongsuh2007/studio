
'use client';
import type { Star } from '@/lib/astro-align';

interface BasicSettings {
  brightness: number;
  exposure: number;
  saturation: number;
}
interface HistogramSettings {
  blackPoint: number;
  midtones: number;
  whitePoint: number;
}
interface StarRemovalSettings {
  strength: number; 
}

// --- Image/Canvas Utilities ---

async function getImageDataFromUrl(url: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return reject(new Error("Could not get canvas context."));
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
        };
        img.onerror = () => reject(new Error("Failed to load image from URL."));
        img.src = url;
    });
}

// --- Morphological Operations ---

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


// --- Star Detection ---
function detectBrightBlobs(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number = 200
): Star[] {
    const { data } = imageData;
    const visited = new Uint8Array(width * height);
    const stars: Star[] = [];
    const minSize = 3; 
    const maxSize = 500;

    const getNeighbors = (pos: number): number[] => {
        const neighbors = [];
        const x = pos % width;
        const y = Math.floor(pos / width);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    neighbors.push(ny * width + nx);
                }
            }
        }
        return neighbors;
    };
    
    const isPixelAboveThreshold = (idx: number) => {
        const base = idx * 4;
        return data[base] > threshold && data[base + 1] > threshold && data[base + 2] > threshold;
    }

    for (let i = 0; i < width * height; i++) {
        if (visited[i] || !isPixelAboveThreshold(i)) continue;

        const queue = [i];
        visited[i] = 1;
        const blobPixels: number[] = [];
        
        while (queue.length > 0) {
            const p = queue.shift()!;
            blobPixels.push(p);

            for (const n of getNeighbors(p)) {
                if (!visited[n] && isPixelAboveThreshold(n)) {
                    visited[n] = 1;
                    queue.push(n);
                }
            }
        }
        
        if (blobPixels.length < minSize || blobPixels.length > maxSize) continue;

        let totalBrightness = 0;
        let weightedX = 0;
        let weightedY = 0;

        for (const p of blobPixels) {
            const b_idx = p * 4;
            const brightness = (data[b_idx] + data[b_idx+1] + data[b_idx+2]) / 3;
            const x = p % width;
            const y = Math.floor(p / width);
            totalBrightness += brightness;
            weightedX += x * brightness;
            weightedY += y * brightness;
        }

        if (totalBrightness > 0) {
            stars.push({
                x: weightedX / totalBrightness,
                y: weightedY / totalBrightness,
                brightness: totalBrightness,
                size: blobPixels.length,
            });
        }
    }

    return stars.sort((a, b) => b.brightness - a.brightness);
}


// --- Main Post-Processing Pipeline ---

export async function calculateHistogram(imageUrl: string) {
  const imageData = await getImageDataFromUrl(imageUrl);
  const { data } = imageData;
  const hist = Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0, level: 0 }));

  for (let i = 0; i < data.length; i += 4) {
    hist[data[i]].r++;
    hist[data[i + 1]].g++;
    hist[data[i + 2]].b++;
  }

  for(let i=0; i<256; i++) hist[i].level = i;

  return hist;
}

function createStarMask(stars: Star[], width: number, height: number, radiusMultiplier: number): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = 'white';
    for (const star of stars) {
        const radius = Math.sqrt(star.size / Math.PI) * radiusMultiplier;
        ctx.beginPath();
        ctx.arc(star.x, star.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
    return ctx.getImageData(0, 0, width, height);
}

function applyStarRemoval(originalData: ImageData, starRemovalRadius: number): ImageData {
    const { width, height, data: src } = originalData;

    // 1. Create a grayscale luminance map of the original image
    const L = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
        L[p] = 0.2126 * src[i] + 0.7152 * src[i+1] + 0.0722 * src[i+2];
    }
    
    // 2. Perform morphological opening on the luminance map
    const circleRows = makeCircularOffsets(starRemovalRadius);
    const L_opened = openingGray(L, width, height, circleRows);

    // 3. Create a "starless" version of the image data
    const starlessData = new Uint8ClampedArray(src.length);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      const scale = L[p] > 0 ? (L_opened[p] / L[p]) : 1;
      starlessData[i] = src[i] * scale;
      starlessData[i+1] = src[i+1] * scale;
      starlessData[i+2] = src[i+2] * scale;
      starlessData[i+3] = src[i+3];
    }

    // 4. Create a star mask
    const stars = detectBrightBlobs(originalData, width, height, 150);
    const starMaskData = createStarMask(stars, width, height, 1.5).data;

    // 5. Blend the original and starless images using the mask
    const finalData = new Uint8ClampedArray(src.length);
    for(let i = 0; i < src.length; i+=4) {
        const maskValue = starMaskData[i] / 255; // 0 for background, 1 for star
        
        finalData[i]   = src[i] * (1 - maskValue) + starlessData[i] * maskValue;
        finalData[i+1] = src[i+1] * (1 - maskValue) + starlessData[i+1] * maskValue;
        finalData[i+2] = src[i+2] * (1 - maskValue) + starlessData[i+2] * maskValue;
        finalData[i+3] = src[i+3];
    }

    return new ImageData(finalData, width, height);
}


export async function applyPostProcessing(
    baseDataUrl: string,
    basic: BasicSettings,
    histogram: HistogramSettings,
    starRemoval: { strength: number, apply: boolean },
    outputFormat: 'png' | 'jpeg',
    jpegQuality: number
): Promise<string> {
    let imageData = await getImageDataFromUrl(baseDataUrl);
    const { width, height } = imageData;

    // --- Star Removal ---
    if (starRemoval.apply && starRemoval.strength > 0) {
        imageData = applyStarRemoval(imageData, starRemoval.strength);
    }
    
    const { data } = imageData;

    // --- Histogram Stretching LUT ---
    const lut = new Uint8ClampedArray(256);
    const { blackPoint, midtones, whitePoint } = histogram;
    const range = whitePoint - blackPoint;
    if (range > 0) {
      for (let i = 0; i < 256; i++) {
        if (i < blackPoint) {
            lut[i] = 0;
        } else if (i > whitePoint) {
            lut[i] = 255;
        } else {
            const val = (i - blackPoint) / range;
            lut[i] = Math.pow(val, 1 / midtones) * 255;
        }
      }
    } else {
       for (let i = 0; i < 256; i++) lut[i] = i; // No stretch
    }


    // --- Basic Adjustments and LUT application ---
    const bFactor = basic.brightness / 100;
    const eFactor = Math.pow(2, basic.exposure / 100);

    for (let i = 0; i < data.length; i += 4) {
      let r = lut[data[i]], g = lut[data[i+1]], b = lut[data[i+2]];

      r = Math.min(255, Math.max(0, r * eFactor * bFactor));
      g = Math.min(255, Math.max(0, g * eFactor * bFactor));
      b = Math.min(255, Math.max(0, b * eFactor * bFactor));

      if (basic.saturation !== 100) {
        const sFactor = basic.saturation / 100;
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = Math.min(255, Math.max(0, gray + sFactor * (r - gray)));
        g = Math.min(255, Math.max(0, gray + sFactor * (g - gray)));
        b = Math.min(255, Math.max(0, gray + sFactor * (b - gray)));
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not create canvas to finalize image.");
    ctx.putImageData(imageData, 0, 0);

    return canvas.toDataURL(outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png', jpegQuality);
}


'use client';
import type { Star } from '@/lib/astro-align';
import { applyMorphologicalOpening } from '@/lib/morphological-removal';

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
  strength: number; // This will now be treated as radius
}

// Helper to get image data from a data URL
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

// This function is no longer used by the new morphological method but kept for potential future use or other features.
export async function detectStarsForRemoval(imageUrl: string, strength: number): Promise<Star[]> {
    if (strength === 0) return [];
    const imageData = await getImageDataFromUrl(imageUrl);
    const { data, width, height } = imageData;
    const threshold = strength * 2.5; 
    const visited = new Uint8Array(width * height);
    const stars: Star[] = [];
    const maxStarSize = 500; 

    const getNeighbors = (pos: number): number[] => {
        const neighbors: number[] = [];
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
        const l = 0.2126 * data[base] + 0.7152 * data[base+1] + 0.0722 * data[base+2];
        return l > threshold;
    };

    for (let i = 0; i < width * height; i++) {
        if (visited[i] || !isPixelAboveThreshold(i)) continue;

        const blobPixels: number[] = [];
        const queue: number[] = [i];
        visited[i] = 1;
        
        let sumX = 0, sumY = 0, sumBrightness = 0;

        while (queue.length > 0) {
            const p = queue.shift()!;
            blobPixels.push(p);

            const x = p % width;
            const y = Math.floor(p / width);
            const brightness = (data[p * 4] + data[p * 4 + 1] + data[p * 4 + 2]) / 3;
            sumX += x * brightness;
            sumY += y * brightness;
            sumBrightness += brightness;
            
            const neighbors = getNeighbors(p);
            for (const n of neighbors) {
                if (!visited[n] && isPixelAboveThreshold(n)) {
                     visited[n] = 1;
                     queue.push(n);
                }
            }
        }
        
        if (blobPixels.length > 0 && blobPixels.length < maxStarSize) {
           stars.push({ x: sumX/sumBrightness, y: sumY/sumBrightness, brightness: sumBrightness, size: blobPixels.length });
        }
    }
    return stars;
}


export async function applyPostProcessing(
    baseDataUrl: string,
    basic: BasicSettings,
    histogram: HistogramSettings,
    starRemoval: { strength: number, apply: boolean }, // strength is now radius
    outputFormat: 'png' | 'jpeg',
    jpegQuality: number
): Promise<string> {
    let imageData = await getImageDataFromUrl(baseDataUrl);
    const { width, height } = imageData;

    // --- Star Removal using Morphological Opening ---
    if (starRemoval.apply && starRemoval.strength > 0) {
        imageData = applyMorphologicalOpening(imageData, starRemoval.strength);
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

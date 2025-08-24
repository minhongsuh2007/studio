
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


export async function applyPostProcessing(
    baseDataUrl: string,
    basic: BasicSettings,
    histogram: HistogramSettings,
    outputFormat: 'png' | 'jpeg',
    jpegQuality: number
): Promise<string> {
    const originalImageData = await getImageDataFromUrl(baseDataUrl);
    const { width, height } = originalImageData;
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not create canvas to finalize image.");
    
    // Get the (potentially inpainted) image data back from the context
    const imageData = originalImageData;
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
    
    ctx.putImageData(imageData, 0, 0);

    return canvas.toDataURL(outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png', jpegQuality);
}

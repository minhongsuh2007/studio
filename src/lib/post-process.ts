
'use client';

import type { PostProcessSettings, Point, Channel } from '@/types';

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

function createLutFromPoints(points: Point[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  if (points.length < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  // Sort points by x-coordinate
  const sortedPoints = [...points].sort((a, b) => a.x - b.x);

  let p1_idx = 0;
  for (let i = 0; i < 256; i++) {
    // Find the two points that surround the current input value `i`
    while (p1_idx < sortedPoints.length - 2 && sortedPoints[p1_idx + 1].x < i) {
      p1_idx++;
    }
    const p1 = sortedPoints[p1_idx];
    const p2 = sortedPoints[p1_idx + 1];

    if (p2.x === p1.x) { // If points are vertical, use the upper point's y-value
      lut[i] = p2.y;
    } else {
      const t = (i - p1.x) / (p2.x - p1.x);
      lut[i] = p1.y * (1 - t) + p2.y * t;
    }
  }
  return lut;
}

// --- Main Post-Processing Pipeline ---

export async function calculateHistogram(imageUrl: string) {
  const imageData = await getImageDataFromUrl(imageUrl);
  const { data } = imageData;
  const hist = Array.from({ length: 256 }, (_, i) => ({ r: 0, g: 0, b: 0, level: i }));

  for (let i = 0; i < data.length; i += 4) {
    hist[data[i]].r++;
    hist[data[i + 1]].g++;
    hist[data[i + 2]].b++;
  }

  return hist;
}


export async function applyPostProcessing(
    baseDataUrl: string,
    settings: PostProcessSettings,
    outputFormat: 'png' | 'jpeg',
    jpegQuality: number
): Promise<string> {
    const originalImageData = await getImageDataFromUrl(baseDataUrl);
    const { width, height, data } = originalImageData;
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not create canvas to finalize image.");
    
    const { basic, curves, colorBalance } = settings;

    // --- Create LUTs from Curves ---
    const lutRgb = createLutFromPoints(curves.rgb);
    const lutR = createLutFromPoints(curves.r);
    const lutG = createLutFromPoints(curves.g);
    const lutB = createLutFromPoints(curves.b);
    
    // --- Apply all adjustments ---
    const bFactor = basic.brightness / 100;
    const eFactor = Math.pow(2, basic.exposure / 100);

    for (let i = 0; i < data.length; i += 4) {
      // 1. Apply Tone Curves
      let r = lutR[lutRgb[data[i]]];
      let g = lutG[lutRgb[data[i+1]]];
      let b = lutB[lutRgb[data[i+2]]];

      // 2. Apply Basic Adjustments (Brightness/Exposure)
      r = Math.min(255, Math.max(0, r * eFactor * bFactor));
      g = Math.min(255, Math.max(0, g * eFactor * bFactor));
      b = Math.min(255, Math.max(0, b * eFactor * bFactor));

      // 3. Apply Color Balance
      const intensity = (r + g + b) / (3 * 255); // 0 to 1
      const shadowWeight = Math.max(0, 1 - intensity * 3);
      const highlightWeight = Math.max(0, (intensity - 0.5) * 2);
      const midtoneWeight = 1 - shadowWeight - highlightWeight;

      r += (colorBalance.shadows.r * shadowWeight) + (colorBalance.midtones.r * midtoneWeight) + (colorBalance.highlights.r * highlightWeight);
      g += (colorBalance.shadows.g * shadowWeight) + (colorBalance.midtones.g * midtoneWeight) + (colorBalance.highlights.g * highlightWeight);
      b += (colorBalance.shadows.b * shadowWeight) + (colorBalance.midtones.b * midtoneWeight) + (colorBalance.highlights.b * highlightWeight);

      // 4. Apply Saturation
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
    
    ctx.putImageData(originalImageData, 0, 0);

    return canvas.toDataURL(outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png', jpegQuality);
}

    
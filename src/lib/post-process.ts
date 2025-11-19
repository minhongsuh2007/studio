
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
    
    const { basic, levels, curves, colorBalance } = settings;

    // --- Create LUTs from Curves ---
    const lutRgb = createLutFromPoints(curves.rgb);
    const lutR = createLutFromPoints(curves.r);
    const lutG = createLutFromPoints(curves.g);
    const lutB = createLutFromPoints(curves.b);
    
    // --- Pre-calculate factors for basic adjustments ---
    const bFactor = basic.brightness / 100;
    const eFactor = Math.pow(2, basic.exposure / 100);
    const contrastFactor = (basic.contrast + 100) / 100;
    const shadowsFactor = basic.shadows / 100;
    const highlightsFactor = basic.highlights / 100;
    const sFactor = basic.saturation / 100;
    
    const invGamma = 1 / levels.gamma;
    const inputRange = Math.max(1, levels.inputWhite - levels.inputBlack);


    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i+1];
      let b = data[i+2];

      // 1. Apply Levels (Black/White point and Gamma)
      r = (Math.max(0, r - levels.inputBlack) / inputRange);
      g = (Math.max(0, g - levels.inputBlack) / inputRange);
      b = (Math.max(0, b - levels.inputBlack) / inputRange);
      
      r = Math.pow(r, invGamma) * 255;
      g = Math.pow(g, invGamma) * 255;
      b = Math.pow(b, invGamma) * 255;

      // 2. Apply Tone Curves
      r = lutRgb[lutR[Math.round(r)]];
      g = lutRgb[lutG[Math.round(g)]];
      b = lutRgb[lutB[Math.round(b)]];

      // 3. Apply Basic Adjustments
      // Exposure & Brightness
      r = r * eFactor * bFactor;
      g = g * eFactor * bFactor;
      b = b * eFactor * bFactor;
      
      // Contrast
      if (contrastFactor !== 1) {
        r = (r - 128) * contrastFactor + 128;
        g = (g - 128) * contrastFactor + 128;
        b = (b - 128) * contrastFactor + 128;
      }
      
      // Shadows & Highlights
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (shadowsFactor !== 0) {
        const shadowAdjust = shadowsFactor * (255 - luma) / 255;
        r += shadowAdjust * (r - luma);
        g += shadowAdjust * (g - luma);
        b += shadowAdjust * (b - luma);
      }
      if (highlightsFactor !== 0) {
        const highlightAdjust = highlightsFactor * luma / 255;
        r += highlightAdjust * (r - luma);
        g += highlightAdjust * (g - luma);
        b += highlightAdjust * (b - luma);
      }
      
      // 4. Apply Color Balance
      const intensity = (r + g + b) / (3 * 255); // 0 to 1
      const shadowWeight = Math.max(0, 1 - intensity * 3);
      const highlightWeight = Math.max(0, (intensity - 0.5) * 2);
      const midtoneWeight = Math.max(0, 1 - shadowWeight - highlightWeight);

      r += (colorBalance.shadows.r * shadowWeight) + (colorBalance.midtones.r * midtoneWeight) + (colorBalance.highlights.r * highlightWeight);
      g += (colorBalance.shadows.g * shadowWeight) + (colorBalance.midtones.g * midtoneWeight) + (colorBalance.highlights.g * highlightWeight);
      b += (colorBalance.shadows.b * shadowWeight) + (colorBalance.midtones.b * midtoneWeight) + (colorBalance.highlights.b * highlightWeight);

      // 5. Apply Saturation
      if (sFactor !== 1) {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + sFactor * (r - gray);
        g = gray + sFactor * (g - gray);
        b = gray + sFactor * (b - gray);
      }
      
      data[i] = Math.min(255, Math.max(0, r));
      data[i + 1] = Math.min(255, Math.max(0, g));
      data[i + 2] = Math.min(255, Math.max(0, b));
    }
    
    ctx.putImageData(originalImageData, 0, 0);

    return canvas.toDataURL(outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png', jpegQuality);
}

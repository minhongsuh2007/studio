
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
  apply: boolean;
}

// Helper to get image data from a data URL
async function getImageDataFromUrl(url: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
        const img = new Image();
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

export async function detectStarsForRemoval(imageUrl: string, strength: number): Promise<Star[]> {
    const imageData = await getImageDataFromUrl(imageUrl);
    const { data, width, height } = imageData;
    const threshold = strength;
    const visited = new Uint8Array(width * height);
    const stars: Star[] = [];

    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const brightness = (data[idx] + data[idx+1] + data[idx+2]) / 3;
        if (!visited[i] && brightness > threshold) {
            const blob: number[] = [];
            const queue = [i];
            visited[i] = 1;
            let sumX = 0; let sumY = 0; let sumBrightness = 0;

            while (queue.length > 0) {
                const current = queue.shift()!;
                blob.push(current);
                const x = current % width;
                const y = Math.floor(current / width);
                const bIdx = current * 4;
                const bVal = (data[bIdx] + data[bIdx+1] + data[bIdx+2]) / 3;

                sumX += x * bVal;
                sumY += y * bVal;
                sumBrightness += bVal;

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx; const ny = y + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                            const neighborIdx = ny * width + nx;
                            const neighborBrightness = (data[neighborIdx*4] + data[neighborIdx*4+1] + data[neighborIdx*4+2]) / 3;
                            if (!visited[neighborIdx] && neighborBrightness > threshold) {
                                visited[neighborIdx] = 1;
                                queue.push(neighborIdx);
                            }
                        }
                    }
                }
            }
             if (blob.length > 0 && sumBrightness > 0) {
                stars.push({ x: sumX / sumBrightness, y: sumY / sumBrightness, brightness: sumBrightness, size: blob.length });
            }
        }
    }
    return stars;
}


export async function applyPostProcessing(
    baseDataUrl: string,
    basic: BasicSettings,
    histogram: HistogramSettings,
    starRemoval: StarRemovalSettings,
    outputFormat: 'png' | 'jpeg',
    jpegQuality: number
): Promise<string> {
    const imageData = await getImageDataFromUrl(baseDataUrl);
    const { data, width, height } = imageData;

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
            lut[i] = Math.pow(val, midtones) * 255;
        }
      }
    } else {
       for (let i = 0; i < 256; i++) lut[i] = i; // No stretch
    }

    // --- Star Removal ---
    if (starRemoval.apply && starRemoval.strength > 0) {
        const stars = await detectStarsForRemoval(baseDataUrl, starRemoval.strength);
        for (const star of stars) {
            const radius = Math.ceil(Math.sqrt(star.size / Math.PI)) + 2;
            const starX = Math.round(star.x);
            const starY = Math.round(star.y);

            let avgR = 0, avgG = 0, avgB = 0, count = 0;

            // Get average color of the surrounding ring
            for (let y = -radius; y <= radius; y++) {
                for (let x = -radius; x <= radius; x++) {
                    const dist = Math.sqrt(x*x + y*y);
                    if (dist > radius -1 && dist <= radius) {
                        const px = starX + x;
                        const py = starY + y;
                        if (px >= 0 && px < width && py >= 0 && py < height) {
                            const idx = (py * width + px) * 4;
                            avgR += data[idx];
                            avgG += data[idx+1];
                            avgB += data[idx+2];
                            count++;
                        }
                    }
                }
            }
            if(count > 0) {
                avgR /= count; avgG /= count; avgB /= count;
            }

            // Fill the star area with the average color
            for (let y = -radius + 1; y < radius; y++) {
                for (let x = -radius + 1; x < radius; x++) {
                    if (x*x + y*y <= (radius-1)*(radius-1)) {
                         const px = starX + x;
                         const py = starY + y;
                         if (px >= 0 && px < width && py >= 0 && py < height) {
                            const idx = (py * width + px) * 4;
                            data[idx] = avgR;
                            data[idx+1] = avgG;
                            data[idx+2] = avgB;
                        }
                    }
                }
            }
        }
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

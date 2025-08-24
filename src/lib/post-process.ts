
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

// --- Star Detection ---
function detectStarsForRemoval(
  imageData: ImageData,
  width: number,
  height: number,
): Star[] {
    const { data } = imageData;
    const visited = new Uint8Array(width * height);
    const stars: Star[] = [];
    const minStarSize = 2; 
    const maxStarSize = 200; // Filter out very large blobs
    const threshold = 180; // Start with a high threshold for bright cores

    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const brightness = (data[idx] + data[idx+1] + data[idx+2]) / 3;
        
        if (visited[i] || brightness < threshold) continue;

        const queue = [i];
        visited[i] = 1;
        const blobPixels: {x: number, y: number}[] = [];
        
        while (queue.length > 0) {
            const pIndex = queue.shift()!;
            const px = pIndex % width;
            const py = Math.floor(pIndex / width);
            blobPixels.push({x: px, y: py});

            for(let dy = -1; dy <= 1; dy++) {
              for(let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = px + dx;
                const ny = py + dy;

                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                  const nIndex = ny * width + nx;
                  if(!visited[nIndex]) {
                    const nBrightness = (data[nIndex*4] + data[nIndex*4+1] + data[nIndex*4+2]) / 3;
                    if (nBrightness > threshold * 0.6) { // Lower threshold for blob growth
                       visited[nIndex] = 1;
                       queue.push(nIndex);
                    }
                  }
                }
              }
            }
        }
        
        if (blobPixels.length >= minStarSize && blobPixels.length <= maxStarSize) {
            let totalBrightness = 0;
            let weightedX = 0;
            let weightedY = 0;

            for (const {x, y} of blobPixels) {
                const b_idx = (y * width + x) * 4;
                const b = (data[b_idx] + data[b_idx+1] + data[b_idx+2]) / 3;
                totalBrightness += b;
                weightedX += x * b;
                weightedY += y * b;
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
    }

    return stars;
}


// --- Inpainting Logic ---

function createStarMask(stars: Star[], width: number, height: number, radiusMultiplier: number): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create star mask context.");
    
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = 'white';
    for (const star of stars) {
        // Use a radius based on the star's detected size for more accuracy
        const radius = Math.sqrt(star.size / Math.PI) * radiusMultiplier;
        ctx.beginPath();
        ctx.arc(star.x, star.y, Math.max(2, radius), 0, Math.PI * 2);
        ctx.fill();
    }
    return ctx.getImageData(0, 0, width, height);
}


/**
 * Removes stars from an image using patch-based inpainting.
 * Assumes you already have a binary mask (star = white, background = black).
 */
function inpaintStars(
  ctx: CanvasRenderingContext2D,
  starMask: ImageData,
  iterations: number = 15
) {
  const { width, height } = starMask;
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const mask = starMask.data;

  // Utility: check if pixel is part of a star
  const isStar = (idx: number) => mask[idx] > 128;

  for (let iter = 0; iter < iterations; iter++) {
    const copy = new Uint8ClampedArray(data); // Work on a copy for this iteration

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;

        if (isStar(idx)) {
          let r = 0, g = 0, b = 0, a=0, wSum = 0;

          // Weighted fill using surrounding non-star pixels
          for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              if (dx === 0 && dy === 0) continue;

              const nx = x + dx;
              const ny = y + dy;
              // Boundary check is important
              if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

              const nIdx = (ny * width + nx) * 4;
              if (!isStar(nIdx)) {
                // Weight = closer pixels count more
                const dist2 = dx * dx + dy * dy;
                const w = 1 / (dist2 + 0.1);

                r += copy[nIdx] * w;
                g += copy[nIdx + 1] * w;
                b += copy[nIdx + 2] * w;
                a += copy[nIdx + 3] * w;
                wSum += w;
              }
            }
          }

          if (wSum > 0) {
            data[idx]     = r / wSum;
            data[idx + 1] = g / wSum;
            data[idx + 2] = b / wSum;
            data[idx + 3] = a / wSum;
          }
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
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
    starRemoval: { strength: number, apply: boolean },
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
    
    ctx.putImageData(originalImageData, 0, 0);

    // --- Star Removal (Inpainting) ---
    if (starRemoval.apply && starRemoval.strength > 0) {
        // strength now controls iterations/quality
        const stars = detectStarsForRemoval(originalImageData, width, height);
        const starMask = createStarMask(stars, width, height, 1.2); // 1.2 multiplier for a small safety margin
        inpaintStars(ctx, starMask, Math.round(starRemoval.strength / 5)); // Scale strength to iterations
    }
    
    // Get the (potentially inpainted) image data back from the context
    const imageData = ctx.getImageData(0, 0, width, height);
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

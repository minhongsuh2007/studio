
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

    const BRIGHT_AREA_THRESHOLD = 220; // Pixels in areas brighter than this won't be considered stars to remove
    const BRIGHT_AREA_CHECK_RADIUS = 10;

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
                const starX = sumX / sumBrightness;
                const starY = sumY / sumBrightness;

                // Check average brightness of the surrounding area to avoid removing nebula cores
                let surroundingBrightness = 0;
                let surroundingCount = 0;
                const startCheckX = Math.max(0, Math.round(starX) - BRIGHT_AREA_CHECK_RADIUS);
                const endCheckX = Math.min(width, Math.round(starX) + BRIGHT_AREA_CHECK_RADIUS);
                const startCheckY = Math.max(0, Math.round(starY) - BRIGHT_AREA_CHECK_RADIUS);
                const endCheckY = Math.min(height, Math.round(starY) + BRIGHT_AREA_CHECK_RADIUS);

                for(let y = startCheckY; y < endCheckY; y++) {
                  for(let x = startCheckX; x < endCheckX; x++) {
                    const checkIdx = (y * width + x) * 4;
                    surroundingBrightness += (data[checkIdx] + data[checkIdx+1] + data[checkIdx+2]) / 3;
                    surroundingCount++;
                  }
                }
                const avgSurroundingBrightness = surroundingCount > 0 ? surroundingBrightness / surroundingCount : 0;

                if (avgSurroundingBrightness < BRIGHT_AREA_THRESHOLD) {
                    stars.push({ x: starX, y: starY, brightness: sumBrightness, size: blob.length });
                }
            }
        }
    }
    return stars;
}

function createStarMask(width: number, height: number, stars: Star[]): Uint8Array {
    const mask = new Uint8Array(width * height).fill(0); // 0 = background, 1 = star
    for (const star of stars) {
        const radius = Math.ceil(Math.sqrt(star.size / Math.PI)) + 2;
        const radiusSq = radius * radius;
        const starX = Math.round(star.x);
        const starY = Math.round(star.y);

        for (let y = -radius; y <= radius; y++) {
            for (let x = -radius; x <= radius; x++) {
                if (x * x + y * y <= radiusSq) {
                    const px = starX + x;
                    const py = starY + y;
                    if (px >= 0 && px < width && py >= 0 && py < height) {
                        mask[py * width + px] = 1;
                    }
                }
            }
        }
    }
    return mask;
}

function inpaint(imageData: ImageData, mask: Uint8Array): void {
    const { data, width, height } = imageData;
    const toFill: number[] = [];

    for(let i = 0; i < mask.length; i++) {
        if(mask[i] === 1) {
            toFill.push(i);
        }
    }
    
    // Sort pixels from edge to center - a simple approximation
    toFill.sort((a, b) => {
        const ax = a % width, ay = Math.floor(a / width);
        const bx = b % width, by = Math.floor(b / width);
        
        const distToCenterA = Math.hypot(ax - width/2, ay - height/2);
        const distToCenterB = Math.hypot(bx - width/2, by - height/2);

        let minBorderDistA = Infinity;
        let minBorderDistB = Infinity;

        for(let y = ay - 3; y <= ay + 3; y++) {
             for(let x = ax - 3; x <= ax + 3; x++) {
                 if (x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 0) {
                     minBorderDistA = Math.min(minBorderDistA, Math.hypot(x-ax, y-ay));
                 }
             }
        }
        for(let y = by - 3; y <= by + 3; y++) {
             for(let x = bx - 3; x <= bx + 3; x++) {
                 if (x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 0) {
                     minBorderDistB = Math.min(minBorderDistB, Math.hypot(x-bx, y-by));
                 }
             }
        }
        
        if(minBorderDistA !== minBorderDistB) return minBorderDistA - minBorderDistB;
        return distToCenterA - distToCenterB;
    });

    for(const pixelIndex of toFill) {
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);

        let sumR = 0, sumG = 0, sumB = 0;
        let totalWeight = 0;

        const searchRadius = 5;

        for(let dy = -searchRadius; dy <= searchRadius; dy++) {
            for(let dx = -searchRadius; dx <= searchRadius; dx++) {
                if(dx === 0 && dy === 0) continue;
                const nx = x + dx;
                const ny = y + dy;

                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const neighborIndex = ny * width + nx;
                    if(mask[neighborIndex] === 0) { // Is a valid background pixel
                        const distSq = dx*dx + dy*dy;
                        const weight = 1 / (distSq + 0.1);
                        const dataIndex = neighborIndex * 4;

                        sumR += data[dataIndex] * weight;
                        sumG += data[dataIndex + 1] * weight;
                        sumB += data[dataIndex + 2] * weight;
                        totalWeight += weight;
                    }
                }
            }
        }

        if(totalWeight > 0) {
            const dataIndex = pixelIndex * 4;
            data[dataIndex] = sumR / totalWeight;
            data[dataIndex + 1] = sumG / totalWeight;
            data[dataIndex + 2] = sumB / totalWeight;
            mask[pixelIndex] = 0; // Mark as filled
        }
    }
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

    // --- Star Removal using Morphological-like Inpainting ---
    if (starRemoval.apply && starRemoval.strength > 0) {
        const stars = await detectStarsForRemoval(baseDataUrl, starRemoval.strength);
        if (stars.length > 0) {
            const starMask = createStarMask(width, height, stars);
            inpaint(imageData, starMask);
        }
    }

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


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
    if (strength === 0) return [];
    const imageData = await getImageDataFromUrl(imageUrl);
    const { data, width, height } = imageData;
    const threshold = strength; 
    const visited = new Uint8Array(width * height);
    const stars: Star[] = [];
    const maxStarSize = 500; // Do not remove blobs larger than this

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
        return (data[base] + data[base + 1] + data[base + 2]) / 3 > threshold;
    };

    for (let i = 0; i < width * height; i++) {
        if (visited[i] || !isPixelAboveThreshold(i)) continue;

        const blobPixels: number[] = [];
        const borderPixels: {x: number, y: number}[] = [];
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

            let isBorder = false;
            const neighbors = getNeighbors(p);
            for (const n of neighbors) {
                if (!visited[n]) {
                     if (isPixelAboveThreshold(n)) {
                        visited[n] = 1;
                        queue.push(n);
                    } else {
                        isBorder = true; 
                    }
                }
            }
            if (isBorder) {
              borderPixels.push({x, y});
            }
        }
        
        const blobSize = blobPixels.length;
        if (blobSize === 0 || blobSize > maxStarSize) continue;

        const centerX = sumX / sumBrightness;
        const centerY = sumY / sumBrightness;
        
        // Circularity check: Compare blob area to the area of a circle defined by its perimeter
        const perimeter = borderPixels.length;
        if (perimeter === 0) continue;

        const circularity = 4 * Math.PI * (blobSize / (perimeter * perimeter));

        // A perfect circle has circularity of 1. Stars should be mostly circular.
        // Nebulosity will be irregular and have low circularity.
        if (circularity > 0.4) {
             stars.push({ x: centerX, y: centerY, brightness: sumBrightness, size: blobSize });
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
    
    // Iteratively fill pixels. This is a simple but effective approach.
    let changed = true;
    while(changed) {
        changed = false;
        for (let i = toFill.length - 1; i >= 0; i--) {
            const pixelIndex = toFill[i];
            const x = pixelIndex % width;
            const y = Math.floor(pixelIndex / width);

            let sumR = 0, sumG = 0, sumB = 0;
            let count = 0;

            // Check 8 neighbors
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;

                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        const neighborIndex = ny * width + nx;
                        if (mask[neighborIndex] === 0) { // Is a valid background pixel
                            const dataIndex = neighborIndex * 4;
                            sumR += data[dataIndex];
                            sumG += data[dataIndex + 1];
                            sumB += data[dataIndex + 2];
                            count++;
                        }
                    }
                }
            }

            if (count > 0) {
                const dataIndex = pixelIndex * 4;
                data[dataIndex] = sumR / count;
                data[dataIndex + 1] = sumG / count;
                data[dataIndex + 2] = sumB / count;
                mask[pixelIndex] = 0; // Mark as filled
                toFill.splice(i, 1);
                changed = true;
            }
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

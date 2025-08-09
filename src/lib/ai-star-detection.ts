
import type { Star } from '@/lib/astro-align';

/**
 * Validates if a star candidate is a real star by checking color consistency.
 * A real star should have a core color that blends outwards, while noise/hot pixels are sharp.
 * @param star The candidate star.
 * @param imageData The image data.
 * @returns True if it's likely a real star.
 */
function isStarColorConsistent(star: Star, imageData: ImageData): boolean {
    const { data, width } = imageData;
    const centerX = Math.round(star.x);
    const centerY = Math.round(star.y);

    if (centerX < 1 || centerX >= width - 1 || centerY < 1 || centerY >= imageData.height - 1) {
        return false; // Cannot analyze border pixels
    }

    const centerIdx = (centerY * width + centerX) * 4;
    const centerR = data[centerIdx];
    const centerG = data[centerIdx + 1];
    const centerB = data[centerIdx + 2];

    if (centerR + centerG + centerB === 0) return false;

    let sumR = 0, sumG = 0, sumB = 0;
    let pixelCount = 0;

    // Analyze 3x3 patch around the center
    for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
            if (i === 0 && j === 0) continue; // Skip center pixel
            const currentIdx = ((centerY + j) * width + (centerX + i)) * 4;
            sumR += data[currentIdx];
            sumG += data[currentIdx + 1];
            sumB += data[currentIdx + 2];
            pixelCount++;
        }
    }

    if (pixelCount === 0) return false;
    
    const avgR = sumR / pixelCount;
    const avgG = sumG / pixelCount;
    const avgB = sumB / pixelCount;

    // Stricter check: if surroundings are very dark, it's likely a hot pixel
    if (avgR + avgG + avgB < 25) { 
        return false;
    }

    // Compare the color ratio of the center pixel to the average of the neighbors.
    // A real star will have similar ratios, noise will not.
    const centerTotal = centerR + centerG + centerB;
    const avgTotal = avgR + avgG + avgB;
    
    const centerRatioR = centerR / centerTotal;
    const centerRatioG = centerG / centerTotal;

    const avgRatioR = avgR / avgTotal;
    const avgRatioG = avgG / avgTotal;

    // Calculate the difference in color ratios.
    const diffR = Math.abs(centerRatioR - avgRatioR);
    const diffG = Math.abs(centerRatioG - avgRatioG);
    
    // Stricter tolerance for color ratio differences (e.g., 12% deviation).
    const COLOR_TOLERANCE = 0.12; 
    return diffR < COLOR_TOLERANCE && diffG < COLOR_TOLERANCE;
}


/**
 * AI-specific star detection. Can be tuned differently from the main one.
 */
export function detectStarsAI(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number
): Star[] {
    const gray = toGrayscale(imageData);
    const visited = new Uint8Array(gray.length);
    const stars: Star[] = [];
    const minSize = 2; 
    const maxSize = 400;

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

    for (let i = 0; i < gray.length; i++) {
        if (visited[i] || gray[i] < threshold) continue;

        const queue = [i];
        visited[i] = 1;
        const blobPixels: number[] = [];
        
        while (queue.length > 0) {
            const p = queue.shift()!;
            blobPixels.push(p);

            for (const n of getNeighbors(p)) {
                if (!visited[n] && gray[n] >= threshold - 15) { // Slightly more lenient neighbor check
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
            const brightness = gray[p];
            const x = p % width;
            const y = Math.floor(p / width);
            totalBrightness += brightness;
            weightedX += x * brightness;
            weightedY += y * brightness;
        }

        if (totalBrightness > 0) {
            const candidateStar: Star = {
                x: weightedX / totalBrightness,
                y: weightedY / totalBrightness,
                brightness: totalBrightness,
                size: blobPixels.length,
            };

            // New validation step to filter out noise and hot pixels
            if (isStarColorConsistent(candidateStar, imageData)) {
                stars.push(candidateStar);
            }
        }
    }

    return stars.sort((a, b) => b.brightness - a.brightness);
}

function toGrayscale(imageData: ImageData): Uint8Array {
  const len = imageData.data.length / 4;
  const gray = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const r = imageData.data[i * 4];
    const g = imageData.data[i * 4 + 1];
    const b = imageData.data[i * 4 + 2];
    gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return gray;
}

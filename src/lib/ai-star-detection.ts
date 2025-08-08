
import type { Star } from '@/lib/astro-align';

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

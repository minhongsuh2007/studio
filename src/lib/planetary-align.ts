
'use client';

import { fft, ifft } from 'mathjs';
import type { StackingMode } from '@/lib/astro-align';
import { stackImagesAverage, stackImagesMedian, stackImagesSigmaClip, stackImagesLaplacian } from '@/lib/astro-align';

// This type definition is duplicated from page.tsx to avoid circular dependencies.
interface ImageQueueEntry {
  id: string;
  imageData: ImageData | null;
  analysisDimensions: { width: number; height: number; };
};

function toGrayscale(imageData: ImageData): number[][] {
    const { width, height, data } = imageData;
    const gray = Array.from({ length: height }, () => new Array(width).fill(0));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            gray[y][x] = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        }
    }
    return gray;
}

function calculateSharpness(grayData: number[][]): number {
    let sharpness = 0;
    const width = grayData[0].length;
    const height = grayData.length;

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const p = grayData[y][x] * 8 - 
                      (grayData[y-1][x-1] + grayData[y-1][x] + grayData[y-1][x+1] +
                       grayData[y][x-1]   + grayData[y][x+1]   +
                       grayData[y+1][x-1] + grayData[y+1][x] + grayData[y+1][x+1]);
            sharpness += p * p;
        }
    }
    return sharpness / (width * height);
}

function phaseCorrelate(ref: number[][], target: number[][]): { dx: number, dy: number } {
    const refFft = fft(ref);
    const targetFft = fft(target);

    const R = refFft.map((row, y) => row.map((val, x) => {
        const targetVal = targetFft[y][x];
        // @ts-ignore
        const numerator = val.mul(targetVal.conjugate());
        // @ts-ignore
        const denominator = numerator.abs() + 1e-10; // Add epsilon to avoid division by zero
        // @ts-ignore
        return numerator.div(denominator);
    }));

    // @ts-ignore
    const ir = ifft(R);

    let maxVal = -Infinity;
    let peakX = 0;
    let peakY = 0;

    ir.forEach((row, y) => {
        row.forEach((val, x) => {
            // @ts-ignore
            const magnitude = val.abs();
            if (magnitude > maxVal) {
                maxVal = magnitude;
                peakX = x;
                peakY = y;
            }
        });
    });

    const height = ref.length;
    const width = ref[0].length;

    const dx = peakX > width / 2 ? peakX - width : peakX;
    const dy = peakY > height / 2 ? peakY - height : peakY;

    return { dx, dy };
}

function warpImageSimple(srcData: Uint8ClampedArray, width: number, height: number, dx: number, dy: number): Uint8ClampedArray {
    const dstData = new Uint8ClampedArray(srcData.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const srcX = x - dx;
            const srcY = y - dy;

            if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
                const srcIdx = (Math.round(srcY) * width + Math.round(srcX)) * 4;
                const dstIdx = (y * width + x) * 4;
                dstData[dstIdx] = srcData[srcIdx];
                dstData[dstIdx + 1] = srcData[srcIdx + 1];
                dstData[dstIdx + 2] = srcData[srcIdx + 2];
                dstData[dstIdx + 3] = srcData[srcIdx + 3];
            }
        }
    }
    return dstData;
}


// --- MAIN PLANETARY ALIGNMENT & STACKING FUNCTION ---
export async function planetaryAlignAndStack(
  imageEntries: ImageQueueEntry[],
  mode: StackingMode,
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  addLog("[PLANETARY] Starting surface-feature alignment and stacking.");
  if (imageEntries.length < 2) {
    throw new Error("Planetary stacking requires at least two images.");
  }
  
  const validEntries = imageEntries.filter(e => e.imageData !== null);
  if(validEntries.length < 2) {
      throw new Error("Fewer than two valid images available for planetary stacking.");
  }

  // 1. Convert all to grayscale and find the sharpest reference image
  addLog("[PLANETARY] Calculating sharpness of all frames to find the best reference...");
  const processedEntries = validEntries.map((entry, index) => {
    const grayData = toGrayscale(entry.imageData!);
    const sharpness = calculateSharpness(grayData);
    setProgress(0.2 * ((index + 1) / validEntries.length));
    return { entry, grayData, sharpness };
  }).sort((a, b) => b.sharpness - a.sharpness);

  const ref = processedEntries[0];
  addLog(`[PLANETARY] Reference frame selected based on sharpness: ${ref.entry.id}`);
  setProgress(0.25);


  // 2. Align all other images to the reference
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [ref.entry.imageData!.data];
  
  for (let i = 1; i < processedEntries.length; i++) {
    const target = processedEntries[i];
    addLog(`[PLANETARY] Aligning ${target.entry.id} to reference...`);
    
    const { dx, dy } = phaseCorrelate(ref.grayData, target.grayData);
    addLog(`[PLANETARY] Detected offset for ${target.entry.id}: dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}`);

    const { width, height } = target.entry.analysisDimensions;
    const warpedData = warpImageSimple(target.entry.imageData!.data, width, height, dx, dy);
    alignedImageDatas.push(warpedData);
    setProgress(0.25 + (0.65 * (i / (processedEntries.length -1) )));
  }

  // 3. Stack the aligned images
  addLog(`[PLANETARY] Stacking ${alignedImageDatas.length} aligned images with mode: ${mode}.`);
  setProgress(0.99);

  const { width, height } = ref.entry.analysisDimensions;
  let stackedResult;
  switch (mode) {
    case 'median':
        stackedResult = stackImagesMedian(alignedImageDatas);
        break;
    case 'sigma':
        stackedResult = stackImagesSigmaClip(alignedImageDatas);
        break;
    case 'laplacian':
        stackedResult = stackImagesLaplacian(alignedImageDatas, width, height);
        break;
    case 'average':
    default:
        stackedResult = stackImagesAverage(alignedImageDatas);
        break;
  }

  setProgress(1);
  addLog("[PLANETARY] Stacking complete.");
  return stackedResult;
}

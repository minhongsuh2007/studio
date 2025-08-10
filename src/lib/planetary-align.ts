
'use client';

import type { StackingMode } from '@/lib/astro-align';
import { stackImagesAverage, stackImagesMedian, stackImagesSigmaClip, stackImagesLaplacian } from '@/lib/astro-align';
import { fft, ifft } from 'mathjs';


// This type definition is duplicated from page.tsx to avoid circular dependencies.
interface ImageQueueEntry {
  id: string;
  file: File;
  imageData: ImageData | null;
  analysisDimensions: { width: number; height: number; };
};

const FFT_SIZE = 256; // Smaller FFT size for faster processing

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


// A faster, more targeted sharpness calculation focusing on a central region.
function calculateSharpness(grayData: number[][]): number {
    let sharpness = 0;
    const height = grayData.length;
    const width = grayData[0].length;
    
    // Analyze a central portion of the image to save time
    const startY = Math.floor(height / 4);
    const endY = Math.floor(height * 3 / 4);
    const startX = Math.floor(width / 4);
    const endX = Math.floor(width * 3 / 4);

    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const p = grayData[y][x] * 4 - 
                      (grayData[y-1][x] + grayData[y+1][x] + grayData[y][x-1] + grayData[y][x+1]);
            sharpness += p * p;
        }
    }
    return sharpness / ((endX - startX) * (endY - startY));
}

// Downsamples a grayscale image using simple nearest neighbor, for performance.
function downsampleGrayscale(grayData: number[][], targetWidth: number, targetHeight: number): number[][] {
    const originalHeight = grayData.length;
    const originalWidth = grayData[0].length;
    const downsampled = Array.from({ length: targetHeight }, () => new Array(targetWidth).fill(0));
    const x_ratio = originalWidth / targetWidth;
    const y_ratio = originalHeight / targetHeight;

    for (let y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++) {
            const px = Math.floor(x * x_ratio);
            const py = Math.floor(y * y_ratio);
            downsampled[y][x] = grayData[py][px];
        }
    }
    return downsampled;
}

function phaseCorrelate(ref: number[][], target: number[][]): { dx: number, dy: number } {
    const originalWidth = ref[0].length;
    const originalHeight = ref.length;

    // Downsample for FFT
    const refSmall = downsampleGrayscale(ref, FFT_SIZE, FFT_SIZE);
    const targetSmall = downsampleGrayscale(target, FFT_SIZE, FFT_SIZE);

    const refFft = fft(refSmall);
    const targetFft = fft(targetSmall);

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
    
    const height = FFT_SIZE;
    const width = FFT_SIZE;

    const small_dx = peakX > width / 2 ? peakX - width : peakX;
    const small_dy = peakY > height / 2 ? peakY - height : peakY;

    // Scale the offset back to the original resolution
    const dx = small_dx * (originalWidth / width);
    const dy = small_dy * (originalHeight / height);

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
  setProgress: (progress: number) => void,
  qualityPercent: number,
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
  addLog(`[PLANETARY] Calculating sharpness of all ${validEntries.length} frames to find the best...`);
  const processedEntries = validEntries.map((entry, index) => {
    const grayData = toGrayscale(entry.imageData!);
    const sharpness = calculateSharpness(grayData);
    setProgress(0.3 * ((index + 1) / validEntries.length));
    return { entry, grayData, sharpness };
  }).sort((a, b) => b.sharpness - a.sharpness);

  const numToStack = Math.max(2, Math.floor(processedEntries.length * (qualityPercent / 100)));
  const bestEntries = processedEntries.slice(0, numToStack);

  const ref = bestEntries[0];
  addLog(`[PLANETARY] Reference frame selected. Stacking top ${numToStack} frames (${qualityPercent}%).`);
  setProgress(0.4);


  // 2. Align all other images to the reference
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [ref.entry.imageData!.data];
  
  for (let i = 1; i < bestEntries.length; i++) {
    const target = bestEntries[i];
    addLog(`[PLANETARY] Aligning ${target.entry.file.name} to reference...`);
    
    const { dx, dy } = phaseCorrelate(ref.grayData, target.grayData);
    addLog(`[PLANETARY] Detected offset for ${target.entry.file.name}: dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}`);

    const { width, height } = target.entry.analysisDimensions;
    const warpedData = warpImageSimple(target.entry.imageData!.data, width, height, dx, dy);
    alignedImageDatas.push(warpedData);
    setProgress(0.4 + (0.5 * (i / (bestEntries.length -1) )));
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

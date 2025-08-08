
'use server';

import type { StackingMode, Transform } from '@/lib/astro-align';
import { findMatchingStars } from '@/lib/ai-star-matcher';
import type { LearnedPattern } from '@/lib/ai-star-matcher';
import type { Star } from '@/lib/astro-align';

// Redefine a serializable version of ImageQueueEntry for server-side use.
export interface SerializableImageQueueEntry {
  id: string;
  file: { name: string };
  imageData: {
      data: number[]; // Received as a plain array
      width: number;
      height: number;
  } | null;
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};


/**
 * Calculates the transformation required to align two point sets based on their two brightest stars.
 * This version uses a more robust method to solve for the similarity transform.
 */
function getTransformFromTwoStars(refStars: Star[], targetStars: Star[], addLog: (m: string) => void): Transform | null {
    if (refStars.length < 2 || targetStars.length < 2) {
        addLog(`[getTransform] Error: Not enough stars. Ref: ${refStars.length}, Target: ${targetStars.length}`);
        return null;
    }

    const [p1, p2] = refStars; // Reference points
    const [q1, q2] = targetStars; // Target points to be aligned

    const p2_minus_p1 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const q2_minus_q1 = { x: q2.x - q1.x, y: q2.y - q1.y };
    
    const p_dist_sq = p2_minus_p1.x**2 + p2_minus_p1.y**2;
    if (p_dist_sq === 0) {
        addLog(`[getTransform] Error: Reference stars are at the same position.`);
        return null;
    }

    const scale = Math.sqrt(p_dist_sq / (q2_minus_q1.x**2 + q2_minus_q1.y**2));
    if (isNaN(scale) || !isFinite(scale)) {
        addLog(`[getTransform] Error: Calculated scale is NaN or infinite. Target stars might be at the same position.`);
        return null;
    }

    const angle = Math.atan2(p2_minus_p1.y, p2_minus_p1.x) - Math.atan2(q2_minus_q1.y, q2_minus_q1.x);
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);

    const dx = p1.x - scale * (q1.x * cosAngle - q1.y * sinAngle);
    const dy = p1.y - scale * (q1.x * sinAngle + q1.y * cosAngle);

    addLog(`[getTransform] Success: scale=${scale.toFixed(3)}, angle=${(angle*180/Math.PI).toFixed(2)}°, dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}`);
    return { dx, dy, angle, scale };
}


/**
 * Warps an image using a similarity transform (translation, rotation, scale).
 * Uses bilinear interpolation for smoother results. This is the INVERSE warp.
 */
function warpImage(
    srcData: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    transform: Transform,
    addLog: (m: string) => void
): Uint8ClampedArray {
    const dstData = new Uint8ClampedArray(srcData.length);
    const { dx, dy, angle, scale } = transform;

    if (scale === 0) {
        addLog("[warpImage] Error: Transform scale is zero. Returning empty image.");
        return dstData;
    }

    const invScale = 1 / scale;
    const cosAngleInv = Math.cos(-angle);
    const sinAngleInv = Math.sin(-angle);

    for (let y_dst = 0; y_dst < srcHeight; y_dst++) {
        for (let x_dst = 0; x_dst < srcWidth; x_dst++) {
            
            const x_translated = x_dst - dx;
            const y_translated = y_dst - dy;

            const x_src = invScale * (x_translated * cosAngleInv - y_translated * sinAngleInv);
            const y_src = invScale * (x_translated * sinAngleInv + y_translated * cosAngleInv);
            
            const x_floor = Math.floor(x_src);
            const y_floor = Math.floor(y_src);
            const x_ceil = x_floor + 1;
            const y_ceil = y_floor + 1;

            if (x_floor < 0 || x_ceil >= srcWidth || y_floor < 0 || y_ceil >= srcHeight) {
                continue;
            }
            
            const x_ratio = x_src - x_floor;
            const y_ratio = y_src - y_floor;

            const dstIdx = (y_dst * srcWidth + x_dst) * 4;

            for (let channel = 0; channel < 3; channel++) {
                 const c00 = srcData[(y_floor * srcWidth + x_floor) * 4 + channel];
                 const c10 = srcData[(y_floor * srcWidth + x_ceil) * 4 + channel];
                 const c01 = srcData[(y_ceil * srcWidth + x_floor) * 4 + channel];
                 const c11 = srcData[(y_ceil * srcWidth + x_ceil) * 4 + channel];

                 const c_x0 = c00 * (1 - x_ratio) + c10 * x_ratio;
                 const c_x1 = c01 * (1 - x_ratio) + c11 * x_ratio;

                 dstData[dstIdx + channel] = c_x0 * (1 - y_ratio) + c_x1 * y_ratio;
            }
            
            if (dstData[dstIdx] > 0 || dstData[dstIdx+1] > 0 || dstData[dstIdx+2] > 0) {
              dstData[dstIdx+3] = 255;
            }
        }
    }
    addLog("[warpImage] Image warping completed.");
    return dstData;
}


// --- STACKING IMPLEMENTATIONS ---

function stackImagesAverage(images: (Uint8ClampedArray | null)[], addLog: (m:string)=>void): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    addLog(`[stackAverage] Stacking ${validImages.length} images.`);
    const length = validImages[0].length;
    const accum = new Float32Array(length);
    const counts = new Uint8Array(length / 4);

    for (const img of validImages) {
        for (let i = 0; i < length; i += 4) {
            if (img[i+3] > 128) {
                accum[i] += img[i];
                accum[i + 1] += img[i + 1];
                accum[i + 2] += img[i + 2];
                counts[i / 4]++;
            }
        }
    }

    const result = new Uint8ClampedArray(length);
    for (let i = 0; i < length; i += 4) {
        const count = counts[i / 4];
        if (count > 0) {
            result[i] = accum[i] / count;
            result[i + 1] = accum[i + 1] / count;
            result[i + 2] = accum[i + 2] / count;
            result[i + 3] = 255;
        }
    }
    addLog(`[stackAverage] Finished.`);
    return result;
}

function stackImagesMedian(images: (Uint8ClampedArray | null)[], addLog: (m:string)=>void): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    addLog(`[stackMedian] Stacking ${validImages.length} images.`);
    const length = validImages[0].length;
    const result = new Uint8ClampedArray(length);

    for (let i = 0; i < length; i += 4) {
        const pixelValuesR: number[] = [];
        const pixelValuesG: number[] = [];
        const pixelValuesB: number[] = [];
        
        for (const img of validImages) {
            if (img[i + 3] > 128) {
                pixelValuesR.push(img[i]);
                pixelValuesG.push(img[i + 1]);
                pixelValuesB.push(img[i + 2]);
            }
        }
        
        if (pixelValuesR.length > 0) {
            pixelValuesR.sort((a, b) => a - b);
            pixelValuesG.sort((a, b) => a - b);
            pixelValuesB.sort((a, b) => a - b);
            const mid = Math.floor(pixelValuesR.length / 2);
            result[i] = pixelValuesR.length % 2 !== 0 ? pixelValuesR[mid] : (pixelValuesR[mid - 1] + pixelValuesR[mid]) / 2;
            result[i+1] = pixelValuesG.length % 2 !== 0 ? pixelValuesG[mid] : (pixelValuesG[mid - 1] + pixelValuesG[mid]) / 2;
            result[i+2] = pixelValuesB.length % 2 !== 0 ? pixelValuesB[mid] : (pixelValuesB[mid - 1] + pixelValuesB[mid]) / 2;
            result[i + 3] = 255;
        }
    }
    addLog(`[stackMedian] Finished.`);
    return result;
}

function stackImagesSigmaClip(images: (Uint8ClampedArray | null)[], addLog: (m:string)=>void, sigma = 2.0): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    addLog(`[stackSigmaClip] Stacking ${validImages.length} images.`);
    const length = validImages[0].length;
    const result = new Uint8ClampedArray(length);

    for (let i = 0; i < length; i += 4) {
        let hasData = false;
        for (let channel = 0; channel < 3; channel++) {
            const pixelValues: number[] = [];
            for (const img of validImages) {
                if (img[i + 3] > 128) {
                    pixelValues.push(img[i + channel]);
                }
            }

            if (pixelValues.length === 0) continue;
            hasData = true;

            if (pixelValues.length < 3) {
                 result[i + channel] = pixelValues.reduce((a, b) => a + b, 0) / pixelValues.length;
                 continue;
            }
            
            const sum = pixelValues.reduce((a,b) => a+b, 0);
            const mean = sum / pixelValues.length;
            const stdev = Math.sqrt(pixelValues.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / pixelValues.length);

            if (stdev === 0) {
                 result[i + channel] = mean;
                 continue;
            }

            const threshold = sigma * stdev;
            const filtered = pixelValues.filter(v => Math.abs(v - mean) < threshold);
            
            if (filtered.length > 0) {
                result[i + channel] = filtered.reduce((a, b) => a + b, 0) / filtered.length;
            } else { 
                 pixelValues.sort((a,b) => a-b);
                 const mid = Math.floor(pixelValues.length / 2);
                 result[i + channel] = pixelValues.length % 2 !== 0 ? pixelValues[mid] : (pixelValues[mid - 1] + pixelValues[mid]) / 2;
            }
        }
        if (hasData) {
            result[i + 3] = 255;
        }
    }
    addLog(`[stackSigmaClip] Finished.`);
    return result;
}


// --- MAIN AI ALIGNMENT & STACKING FUNCTION ---
export async function aiAlignAndStack(
  imageEntries: SerializableImageQueueEntry[],
  learnedPatterns: LearnedPattern[],
  mode: StackingMode,
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  addLog("[aiAlignAndStack] Starting AI alignment and stacking process.");
  if (imageEntries.length === 0) {
    addLog("[aiAlignAndStack] Error: No images provided.");
    throw new Error("No valid images provided for stacking.");
  }
  if (!imageEntries[0].imageData) {
    addLog("[aiAlignAndStack] Error: Reference image has no image data.");
    throw new Error("Reference image has no data.");
  }

  const refEntry = imageEntries[0];
  const { width, height } = refEntry.analysisDimensions;
  
  const refImageData = new Uint8ClampedArray(refEntry.imageData.data);
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refImageData];
  
  const refSimpleImageData = { ...refEntry.imageData, data: Array.from(refImageData) };

  addLog(`[aiAlignAndStack] Finding matching stars for reference image: ${refEntry.file.name}`);
  const refStars = (await findMatchingStars({ allDetectedStars: refEntry.detectedStars, imageData: refSimpleImageData, learnedPatterns, addLog }))
    .sort((a, b) => b.brightness - a.brightness);

  if (refStars.length < 2) {
    addLog(`[aiAlignAndStack] Error: AI Pattern matching found ${refStars.length} stars in reference image. Cannot align.`);
    throw new Error("AI Pattern matching found fewer than 2 stars in reference image. Cannot align.");
  }
  addLog(`[aiAlignAndStack] Found ${refStars.length} matching stars in reference.`);

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    addLog(`--- Aligning Image ${i+1}/${imageEntries.length}: ${targetEntry.file.name} ---`);
    setProgress((i) / imageEntries.length);

    if (!targetEntry.imageData) {
      addLog(`Skipping image ${targetEntry.file.name}: missing image data.`);
      alignedImageDatas.push(null);
      continue;
    }

    const targetClampedData = new Uint8ClampedArray(targetEntry.imageData.data);
    const targetSimpleImageData = { ...targetEntry.imageData, data: Array.from(targetClampedData) };
    
    addLog(`[aiAlignAndStack] Finding matching stars for target image: ${targetEntry.file.name}`);
    const targetStars = (await findMatchingStars({ allDetectedStars: targetEntry.detectedStars, imageData: targetSimpleImageData, learnedPatterns, addLog }))
        .sort((a, b) => b.brightness - a.brightness);

    if (targetStars.length < 2) {
        addLog(`Skipping image ${targetEntry.file.name}: AI pattern matching found only ${targetStars.length} stars.`);
        alignedImageDatas.push(null);
        continue;
    }
     addLog(`[aiAlignAndStack] Found ${targetStars.length} matching stars in target.`);

    const transform = getTransformFromTwoStars(refStars, targetStars, addLog);

    if (!transform) {
        addLog(`Could not determine robust AI transform for ${targetEntry.file.name}. Skipping.`);
        alignedImageDatas.push(null);
        continue;
    }
    
    addLog(`Warping image ${targetEntry.file.name}...`);
    const warpedData = warpImage(targetClampedData, width, height, transform, addLog);
    alignedImageDatas.push(warpedData);
  }

  addLog(`All images processed. Stacking with mode: ${mode}...`);
  setProgress(1);

  switch (mode) {
    case 'median':
        return stackImagesMedian(alignedImageDatas, addLog);
    case 'sigma':
        return stackImagesSigmaClip(alignedImageDatas, addLog);
    case 'average':
    default:
        return stackImagesAverage(alignedImageDatas, addLog);
  }
}

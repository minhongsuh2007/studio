
'use server';

import type { StackingMode, Transform } from '@/lib/astro-align';
import { findMatchingStars } from '@/lib/ai-star-matcher';
import type { LearnedPattern, SimpleImageData } from '@/lib/ai-star-matcher';
import type { Star } from '@/lib/astro-align';

// Redefine a serializable version of ImageQueueEntry for server-side use.
export interface SerializableImageQueueEntry {
  id: string;
  fileName: string;
  imageData: SimpleImageData | null,
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};

/**
 * Calculates the transformation required to align two point sets.
 * Solves for the similarity transform (translation, rotation, scale).
 */
function getTransformFromTwoStars(refStars: Star[], targetStars: Star[], logs: string[]): Transform | null {
    if (refStars.length < 2 || targetStars.length < 2) {
        logs.push(`[getTransform] Error: Not enough stars. Ref: ${refStars.length}, Target: ${targetStars.length}`);
        return null;
    }

    const [p1, p2] = refStars; // Reference points
    const [q1, q2] = targetStars; // Target points to be aligned

    const p2_minus_p1 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const q2_minus_q1 = { x: q2.x - q1.x, y: q2.y - q1.y };
    
    // Using dot and cross product to find scale and rotation
    const p_dot_q = p2_minus_p1.x * q2_minus_q1.x + p2_minus_p1.y * q2_minus_q1.y;
    const p_cross_q = p2_minus_p1.x * q2_minus_q1.y - p2_minus_p1.y * q2_minus_q1.x;
    
    const q_len_sq = q2_minus_q1.x**2 + q2_minus_q1.y**2;
    if (q_len_sq === 0) {
        logs.push(`[getTransform] Error: Target stars are at the same position.`);
        return null;
    }

    const a = p_dot_q / q_len_sq;
    const b = p_cross_q / q_len_sq;

    const scale = Math.sqrt(a**2 + b**2);
    const angle = Math.atan2(b, a); // atan2(sin, cos)

    // Now solve for translation
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);

    const dx = p1.x - scale * (q1.x * cosAngle - q1.y * sinAngle);
    const dy = p1.y - scale * (q1.x * sinAngle + q1.y * cosAngle);

    logs.push(`[getTransform] Success: scale=${scale.toFixed(3)}, angle=${(angle*180/Math.PI).toFixed(2)}°, dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}`);
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
    logs: string[]
): Uint8ClampedArray | null {
    const dstData = new Uint8ClampedArray(srcData.length);
    const { dx, dy, angle, scale } = transform;

    if (scale === 0) {
        logs.push("[warpImage] Error: Transform scale is zero. Returning empty image.");
        return null;
    }

    const invScale = 1 / scale;
    const cosAngle = Math.cos(-angle); // Use the negative angle for inverse rotation
    const sinAngle = Math.sin(-angle);

    for (let y_dst = 0; y_dst < srcHeight; y_dst++) {
        for (let x_dst = 0; x_dst < srcWidth; x_dst++) {
            
            // Step 1: Inverse translate the destination coordinate
            const x_translated = x_dst - dx;
            const y_translated = y_dst - dy;
            
            // Step 2: Inverse rotate and scale to find the source coordinate
            const x_src = invScale * (x_translated * cosAngle - y_translated * sinAngle);
            const y_src = invScale * (x_translated * sinAngle + y_translated * cosAngle);
            
            // Check if the source coordinate is within the bounds of the source image
            if (x_src < 0 || x_src >= srcWidth - 1 || y_src < 0 || y_src >= srcHeight - 1) {
                continue; // This pixel is outside the source image, leave it black (and transparent)
            }

            // Step 3: Bilinear interpolation
            const x_floor = Math.floor(x_src);
            const y_floor = Math.floor(y_src);
            const x_ceil = x_floor + 1;
            const y_ceil = y_floor + 1;

            const x_ratio = x_src - x_floor;
            const y_ratio = y_src - y_floor;

            const dstIdx = (y_dst * srcWidth + x_dst) * 4;

            for (let channel = 0; channel < 3; channel++) { // RGB channels
                 const c00 = srcData[(y_floor * srcWidth + x_floor) * 4 + channel];
                 const c10 = srcData[(y_floor * srcWidth + x_ceil) * 4 + channel];
                 const c01 = srcData[(y_ceil * srcWidth + x_floor) * 4 + channel];
                 const c11 = srcData[(y_ceil * srcWidth + x_ceil) * 4 + channel];

                 const c_x0 = c00 * (1 - x_ratio) + c10 * x_ratio;
                 const c_x1 = c01 * (1 - x_ratio) + c11 * x_ratio;

                 dstData[dstIdx + channel] = c_x0 * (1 - y_ratio) + c_x1 * y_ratio;
            }
            // Mark the pixel as opaque since it has data
            dstData[dstIdx + 3] = 255;
        }
    }
    logs.push("[warpImage] Image warping completed.");
    return dstData;
}


// --- ROBUST STACKING IMPLEMENTATIONS ---

function stackImagesAverage(images: Uint8ClampedArray[], logs: string[]): Uint8ClampedArray {
    logs.push(`[stackAverage] Stacking ${images.length} images.`);
    const length = images[0].length;
    const accum = new Float32Array(length);
    const counts = new Uint8Array(length / 4);

    for (const img of images) {
        for (let i = 0; i < length; i += 4) {
            if (img[i+3] > 128) { // Check alpha channel
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
    logs.push(`[stackAverage] Finished.`);
    return result;
}

function stackImagesMedian(images: Uint8ClampedArray[], logs: string[]): Uint8ClampedArray {
    logs.push(`[stackMedian] Stacking ${images.length} images.`);
    const length = images[0].length;
    const result = new Uint8ClampedArray(length);
    const pixelValuesR: number[] = [];
    const pixelValuesG: number[] = [];
    const pixelValuesB: number[] = [];
    
    for (let i = 0; i < length; i += 4) {
        pixelValuesR.length = 0;
        pixelValuesG.length = 0;
        pixelValuesB.length = 0;
        
        for (const img of images) {
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
    logs.push(`[stackMedian] Finished.`);
    return result;
}

function stackImagesSigmaClip(images: Uint8ClampedArray[], logs: string[], sigma = 2.0): Uint8ClampedArray {
    logs.push(`[stackSigmaClip] Stacking ${images.length} images.`);
    const length = images[0].length;
    const result = new Uint8ClampedArray(length);

    for (let i = 0; i < length; i += 4) {
        let hasData = false;
        for (let channel = 0; channel < 3; channel++) {
            const pixelValues: number[] = [];
            for (const img of images) {
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

            // If stdev is 0, all pixels are the same. Just use the mean.
            if (stdev === 0) {
                 result[i + channel] = mean;
                 continue;
            }

            const threshold = sigma * stdev;
            const filtered = pixelValues.filter(v => Math.abs(v - mean) < threshold);
            
            if (filtered.length > 0) {
                result[i + channel] = filtered.reduce((a, b) => a + b, 0) / filtered.length;
            } else { // If all pixels are outliers, fallback to median
                 pixelValues.sort((a,b) => a-b);
                 const mid = Math.floor(pixelValues.length / 2);
                 result[i + channel] = pixelValues.length % 2 !== 0 ? pixelValues[mid] : (pixelValues[mid - 1] + pixelValues[mid]) / 2;
            }
        }
        if (hasData) {
            result[i + 3] = 255;
        }
    }
    logs.push(`[stackSigmaClip] Finished.`);
    return result;
}


// --- MAIN AI ALIGNMENT & STACKING FUNCTION ---
export async function aiAlignAndStack(
  imageEntries: SerializableImageQueueEntry[],
  learnedPatterns: LearnedPattern[],
  mode: StackingMode
): Promise<{stackedImageData: number[] | null, logs: string[]}> {
  const logs: string[] = [];
  logs.push("[aiAlignAndStack] Starting AI alignment and stacking process.");
  
  try {
    if (imageEntries.length === 0) {
      logs.push("[aiAlignAndStack] Error: No images provided.");
      throw new Error("No valid images provided for stacking.");
    }
    if (!imageEntries[0].imageData) {
      logs.push("[aiAlignAndStack] Error: Reference image has no image data.");
      throw new Error("Reference image has no data.");
    }

    const refEntry = imageEntries[0];
    const { width, height } = refEntry.analysisDimensions;
    
    const refImageData = new Uint8ClampedArray(refEntry.imageData.data);
    const alignedImageDatas: (Uint8ClampedArray | null)[] = [refImageData];
    
    logs.push(`[aiAlignAndStack] Finding matching stars for reference image: ${refEntry.fileName}`);
    const refStars = (await findMatchingStars({ allDetectedStars: refEntry.detectedStars, imageData: refEntry.imageData, learnedPatterns, addLog: (m:string) => logs.push(m) }))
      .sort((a, b) => b.brightness - a.brightness);

    if (refStars.length < 2) {
      logs.push(`[aiAlignAndStack] Error: AI Pattern matching found ${refStars.length} stars in reference image. Cannot align.`);
      throw new Error("AI Pattern matching found fewer than 2 stars in reference image. Cannot align.");
    }
    logs.push(`[aiAlignAndStack] Found ${refStars.length} matching stars in reference.`);

    for (let i = 1; i < imageEntries.length; i++) {
      const targetEntry = imageEntries[i];
      logs.push(`--- Aligning Image ${i+1}/${imageEntries.length}: ${targetEntry.fileName} ---`);

      if (!targetEntry.imageData) {
        logs.push(`Skipping image ${targetEntry.fileName}: missing image data.`);
        alignedImageDatas.push(null);
        continue;
      }

      const targetClampedData = new Uint8ClampedArray(targetEntry.imageData.data);
      
      logs.push(`[aiAlignAndStack] Finding matching stars for target image: ${targetEntry.fileName}`);
      const targetStars = (await findMatchingStars({ allDetectedStars: targetEntry.detectedStars, imageData: targetEntry.imageData, learnedPatterns, addLog: (m:string) => logs.push(m) }))
          .sort((a, b) => b.brightness - a.brightness);

      if (targetStars.length < 2) {
          logs.push(`Skipping image ${targetEntry.fileName}: AI pattern matching found only ${targetStars.length} stars.`);
          alignedImageDatas.push(null);
          continue;
      }
      logs.push(`[aiAlignAndStack] Found ${targetStars.length} matching stars in target.`);

      const transform = getTransformFromTwoStars(refStars, targetStars, logs);

      if (!transform) {
          logs.push(`Could not determine robust AI transform for ${targetEntry.fileName}. Skipping.`);
          alignedImageDatas.push(null);
          continue;
      }
      
      logs.push(`Warping image ${targetEntry.fileName}...`);
      const warpedData = warpImage(targetClampedData, width, height, transform, logs);
      alignedImageDatas.push(warpedData);
    }

    logs.push(`All images processed. Stacking with mode: ${mode}...`);

    const validImagesToStack = alignedImageDatas.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImagesToStack.length < 1) {
      throw new Error("No images could be successfully aligned to stack.");
    }
    
    let finalImage: Uint8ClampedArray;
    switch (mode) {
      case 'median':
          finalImage = stackImagesMedian(validImagesToStack, logs);
          break;
      case 'sigma':
          finalImage = stackImagesSigmaClip(validImagesToStack, logs);
          break;
      case 'average':
      default:
          finalImage = stackImagesAverage(validImagesToStack, logs);
          break;
    }
    return { stackedImageData: Array.from(finalImage), logs };

  } catch(e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logs.push(`[CRITICAL ERROR in aiAlignAndStack]: ${errorMessage}`);
      console.error(e);
      // Return logs but no image data on crash
      return { stackedImageData: null, logs };
  }
}

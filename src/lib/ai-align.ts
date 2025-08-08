
'use server';

import type { StackingMode, Transform } from '@/lib/astro-align';
import { findMatchingStars } from '@/lib/ai-star-matcher';
import type { LearnedPattern } from '@/lib/ai-star-matcher';
import type { Star } from '@/lib/astro-align';

// Redefine a serializable version of ImageQueueEntry for server-side use.
export interface SerializableImageQueueEntry {
  id: string;
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
function getTransformFromTwoStars(refStars: Star[], targetStars: Star[]): Transform | null {
    if (refStars.length < 2 || targetStars.length < 2) {
        return null;
    }

    const [p1, p2] = refStars; // Reference points
    const [q1, q2] = targetStars; // Target points to be aligned

    const p2_minus_p1 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const q2_minus_q1 = { x: q2.x - q1.x, y: q2.y - q1.y };
    
    const p_dist_sq = p2_minus_p1.x**2 + p2_minus_p1.y**2;
    const q_dist_sq = q2_minus_q1.x**2 + q2_minus_q1.y**2;
    
    if (p_dist_sq === 0 || q_dist_sq === 0) return null;

    // s * R * q + t = p
    // where s is scale, R is rotation matrix, t is translation vector.
    // Let's solve for scale, rotation, and translation.

    const scale = Math.sqrt(p_dist_sq / q_dist_sq);

    // Rotation angle
    const angle = Math.atan2(p2_minus_p1.y, p2_minus_p1.x) - Math.atan2(q2_minus_q1.y, q2_minus_q1.x);
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);

    // Translation (dx, dy)
    // p1 = s * R * q1 + t
    // t = p1 - s * R * q1
    const dx = p1.x - scale * (q1.x * cosAngle - q1.y * sinAngle);
    const dy = p1.y - scale * (q1.x * sinAngle + q1.y * cosAngle);

    // This transform maps a point q from the target image to a point p in the reference image.
    // p_x = s * (q_x * cos(a) - q_y * sin(a)) + dx
    // p_y = s * (q_x * sin(a) + q_y * cos(a)) + dy
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
    transform: Transform
): Uint8ClampedArray {
    const dstData = new Uint8ClampedArray(srcData.length);
    const { dx, dy, angle, scale } = transform;

    if (scale === 0) return dstData;

    // We need the INVERSE transform to go from destination pixel to source pixel
    // p_src = (1/s) * R' * (p_dst - t)
    const invScale = 1 / scale;
    const cosAngleInv = Math.cos(-angle);
    const sinAngleInv = Math.sin(-angle);

    for (let y_dst = 0; y_dst < srcHeight; y_dst++) {
        for (let x_dst = 0; x_dst < srcWidth; x_dst++) {
            
            // Apply inverse translation
            const x_translated = x_dst - dx;
            const y_translated = y_dst - dy;

            // Apply inverse rotation and scaling
            const x_src = invScale * (x_translated * cosAngleInv - y_translated * sinAngleInv);
            const y_src = invScale * (x_translated * sinAngleInv + y_translated * cosAngleInv);
            
            // Bilinear interpolation
            const x_floor = Math.floor(x_src);
            const y_floor = Math.floor(y_src);
            const x_ceil = x_floor + 1;
            const y_ceil = y_floor + 1;

            if (x_floor < 0 || x_ceil >= srcWidth || y_floor < 0 || y_ceil >= srcHeight) {
                continue; // Pixel is outside the source image bounds
            }
            
            const x_ratio = x_src - x_floor;
            const y_ratio = y_src - y_floor;

            const dstIdx = (y_dst * srcWidth + x_dst) * 4;

            for (let channel = 0; channel < 3; channel++) { // Only process R, G, B
                 const c00 = srcData[(y_floor * srcWidth + x_floor) * 4 + channel];
                 const c10 = srcData[(y_floor * srcWidth + x_ceil) * 4 + channel];
                 const c01 = srcData[(y_ceil * srcWidth + x_floor) * 4 + channel];
                 const c11 = srcData[(y_ceil * srcWidth + x_ceil) * 4 + channel];

                 const c_x0 = c00 * (1 - x_ratio) + c10 * x_ratio;
                 const c_x1 = c01 * (1 - x_ratio) + c11 * x_ratio;

                 dstData[dstIdx + channel] = c_x0 * (1 - y_ratio) + c_x1 * y_ratio;
            }
            // If any color data was written, set alpha to 255 to mark it as valid.
            if (dstData[dstIdx] > 0 || dstData[dstIdx+1] > 0 || dstData[dstIdx+2] > 0) {
              dstData[dstIdx+3] = 255;
            }
        }
    }
    return dstData;
}


// --- STACKING IMPLEMENTATIONS ---

function stackImagesAverage(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const accum = new Float32Array(length);
    const counts = new Uint8Array(length / 4);

    for (const img of validImages) {
        for (let i = 0; i < length; i += 4) {
            if (img[i+3] > 128) { // Use a threshold for alpha
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
    return result;
}

function stackImagesMedian(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const result = new Uint8ClampedArray(length);

    for (let i = 0; i < length; i += 4) {
        const pixelValuesR: number[] = [];
        const pixelValuesG: number[] = [];
        const pixelValuesB: number[] = [];
        
        for (const img of validImages) {
            if (img[i + 3] > 128) { // Consider only valid pixels
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
    return result;
}

function stackImagesSigmaClip(images: (Uint8ClampedArray | null)[], sigma = 2.0): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
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
            } else { // Fallback to median if all pixels are clipped
                 pixelValues.sort((a,b) => a-b);
                 const mid = Math.floor(pixelValues.length / 2);
                 result[i + channel] = pixelValues.length % 2 !== 0 ? pixelValues[mid] : (pixelValues[mid - 1] + pixelValues[mid]) / 2;
            }
        }
        if (hasData) {
            result[i + 3] = 255;
        }
    }
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
  if (imageEntries.length === 0 || !imageEntries[0].imageData) {
    throw new Error("No valid images provided for stacking.");
  }

  const refEntry = imageEntries[0];
  const { width, height } = refEntry.analysisDimensions;
  
  if (!refEntry.imageData) throw new Error("Reference image has no data.");

  const refImageData = new Uint8ClampedArray(refEntry.imageData.data);
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refImageData];
  
  const refSimpleImageData = { ...refEntry.imageData, data: Array.from(refImageData) };

  const refStars = (await findMatchingStars({ allDetectedStars: refEntry.detectedStars, imageData: refSimpleImageData, learnedPatterns }))
    .sort((a, b) => b.brightness - a.brightness);

  if (refStars.length < 2) {
    addLog(`Error: AI Pattern matching found fewer than 2 stars in reference image. Cannot align.`);
    throw new Error("AI Pattern matching found fewer than 2 stars in reference image. Cannot align.");
  }
  addLog(`Using ${refStars.length} AI-matched stars from reference image.`);

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    const progress = (i + 1) / imageEntries.length;
    addLog(`--- Aligning Image ${i+1}/${imageEntries.length} with AI Pattern ---`);

    if (!targetEntry.imageData) {
      addLog(`Skipping image ${i+1}: missing image data.`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }

    const targetClampedData = new Uint8ClampedArray(targetEntry.imageData.data);
    const targetSimpleImageData = { ...targetEntry.imageData, data: Array.from(targetClampedData) };
    
    const targetStars = (await findMatchingStars({ allDetectedStars: targetEntry.detectedStars, imageData: targetSimpleImageData, learnedPatterns }))
        .sort((a, b) => b.brightness - a.brightness);

    if (targetStars.length < 2) {
        addLog(`Skipping image ${i+1}: AI pattern matching found fewer than 2 stars.`);
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }

    const transform = getTransformFromTwoStars(refStars, targetStars);

    if (!transform) {
        addLog(`Could not determine robust AI transform for ${targetEntry.id}. Skipping.`);
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }
    
    addLog(`Image ${i+1}: Applying AI transform (dx: ${transform.dx.toFixed(2)}, dy: ${transform.dy.toFixed(2)}, angle: ${(transform.angle * 180 / Math.PI).toFixed(3)}°, scale: ${transform.scale.toFixed(3)})`);

    const warpedData = warpImage(targetClampedData, width, height, transform);
    alignedImageDatas.push(warpedData);
    
    setProgress(progress);
  }

  addLog("All images processed. Stacking...");
  setProgress(1);

  switch (mode) {
    case 'median':
        addLog("Using Median stacking mode.");
        return stackImagesMedian(alignedImageDatas);
    case 'sigma':
        addLog("Using Sigma Clipping stacking mode.");
        return stackImagesSigmaClip(alignedImageDatas);
    case 'average':
    default:
        addLog("Using Average stacking mode.");
        return stackImagesAverage(alignedImageDatas);
  }
}

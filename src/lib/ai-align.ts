
'use server';

import type { StackingMode, Transform } from '@/lib/astro-align';
import { findMatchingStars } from '@/lib/ai-star-matcher';
import type { LearnedPattern, SimpleImageData } from '@/lib/ai-star-matcher';
import type { Star } from '@/lib/astro-align';

// Redefine a serializable version of ImageQueueEntry for server-side use.
export interface SerializableImageQueueEntry {
  id: string;
  imageData: {
      data: number[];
      width: number;
      height: number;
  } | null;
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};


/**
 * Calculates the transformation required to align two points sets based on their two brightest stars.
 */
function getTransformFromTwoStars(refStars: Star[], targetStars: Star[]): Transform | null {
    if (refStars.length < 2 || targetStars.length < 2) {
        return null;
    }

    const [ref1, ref2] = refStars;
    const [target1, target2] = targetStars;

    // Vectors from star1 to star2
    const refVec = { x: ref2.x - ref1.x, y: ref2.y - ref1.y };
    const targetVec = { x: target2.x - target1.x, y: target2.y - target1.y };

    const refDist = Math.sqrt(refVec.x * refVec.x + refVec.y * refVec.y);
    const targetDist = Math.sqrt(targetVec.x * targetVec.x + targetVec.y * targetVec.y);

    if (refDist < 1e-6) return null;
    const scale = targetDist / refDist;
    if (scale === 0) return null;

    const refAngle = Math.atan2(refVec.y, refVec.x);
    const targetAngle = Math.atan2(targetVec.y, targetVec.x);
    const angle = targetAngle - refAngle;

    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    
    // The transformation maps a point p_target to p_ref
    // p_ref.x = scale * (p_target.x * cos - p_target.y * sin) + dx
    // p_ref.y = scale * (p_target.x * sin + p_target.y * cos) + dy
    // We can solve for dx and dy using our reference star `target1` which should map to `ref1`
    
    const dx = ref1.x - scale * (target1.x * cosAngle - target1.y * sinAngle);
    const dy = ref1.y - scale * (target1.x * sinAngle + target1.y * cosAngle);

    // We return the INVERSE transform params for warping, but it's easier to compute the forward one first.
    return { dx, dy, angle, scale };
}


/**
 * Warps an image using a similarity transform (translation, rotation, scale).
 * Uses bilinear interpolation for smoother results.
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
    const invScale = 1 / scale;
    const cosAngle = Math.cos(-angle);
    const sinAngle = Math.sin(-angle);

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            
            // Apply inverse translation
            const translatedX = x - dx;
            const translatedY = y - dy;

            // Apply inverse rotation and scaling
            const srcX = invScale * (translatedX * cosAngle - translatedY * sinAngle);
            const srcY = invScale * (translatedX * sinAngle + translatedY * cosAngle);
            
            // Bilinear interpolation
            const x_floor = Math.floor(srcX);
            const y_floor = Math.floor(srcY);

            if (x_floor < 0 || x_floor >= srcWidth - 1 || y_floor < 0 || y_floor >= srcHeight - 1) {
                continue; // Pixel is outside the source image bounds
            }
            
            const x_ceil = x_floor + 1;
            const y_ceil = y_floor + 1;
            
            const x_ratio = srcX - x_floor;
            const y_ratio = srcY - y_floor;

            const dstIdx = (y * srcWidth + x) * 4;

            for (let channel = 0; channel < 4; channel++) {
                 const c00 = srcData[(y_floor * srcWidth + x_floor) * 4 + channel];
                 const c10 = srcData[(y_floor * srcWidth + x_ceil) * 4 + channel];
                 const c01 = srcData[(y_ceil * srcWidth + x_floor) * 4 + channel];
                 const c11 = srcData[(y_ceil * srcWidth + x_ceil) * 4 + channel];

                 // These checks should not be necessary with the bounds check above, but as a safeguard:
                 if (c00 === undefined || c10 === undefined || c01 === undefined || c11 === undefined) continue;

                 const c_x0 = c00 * (1 - x_ratio) + c10 * x_ratio;
                 const c_x1 = c01 * (1 - x_ratio) + c11 * x_ratio;

                 dstData[dstIdx + channel] = c_x0 * (1 - y_ratio) + c_x1 * y_ratio;
            }
            // Ensure alpha is set for pixels with color data
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
    const pixelValues: number[] = [];

    for (let i = 0; i < length; i += 4) {
        let hasData = false;
        for (let channel = 0; channel < 3; channel++) {
            pixelValues.length = 0;
            for (const img of validImages) {
                if (img[i + 3] > 128) {
                    pixelValues.push(img[i + channel]);
                }
            }
            if (pixelValues.length > 0) {
                hasData = true;
                pixelValues.sort((a, b) => a - b);
                const mid = Math.floor(pixelValues.length / 2);
                result[i + channel] = pixelValues.length % 2 !== 0
                    ? pixelValues[mid]
                    : (pixelValues[mid - 1] + pixelValues[mid]) / 2;
            }
        }
        
        if (hasData) {
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
    const pixelValues: number[] = [];

    for (let i = 0; i < length; i += 4) {
        let hasData = false;
        for (let channel = 0; channel < 3; channel++) {
            pixelValues.length = 0;
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

  const alignedImageDatas: (Uint8ClampedArray | null)[] = [new Uint8ClampedArray(refEntry.imageData.data)];
  
  const refStars = (await findMatchingStars({ allDetectedStars: refEntry.detectedStars, imageData: refEntry.imageData, learnedPatterns }))
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

    const { data: targetData, width: targetWidth, height: targetHeight } = targetEntry.imageData;
    const targetStars = (await findMatchingStars({ allDetectedStars: targetEntry.detectedStars, imageData: {data: targetData, width: targetWidth, height: targetHeight }, learnedPatterns }))
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

    const warpedData = warpImage(new Uint8ClampedArray(targetEntry.imageData.data), width, height, transform);
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

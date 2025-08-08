
'use server';

import type { StackingMode, Transform, ImageQueueEntry } from '@/lib/astro-align';
import { findMatchingStars } from '@/lib/ai-star-matcher';
import type { LearnedPattern } from '@/lib/ai-star-matcher';
import type { Star } from '@/lib/astro-align';


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

    const cosAngle = Math.cos(-angle);
    const sinAngle = Math.sin(-angle);
    
    const rotatedTargetX = target1.x * cosAngle - target1.y * sinAngle;
    const rotatedTargetY = target1.x * sinAngle + target1.y * cosAngle;

    const dx = ref1.x - rotatedTargetX / scale;
    const dy = ref1.y - rotatedTargetY / scale;
    
    return { dx, dy, angle: -angle, scale: 1/scale };
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

    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    
    const invScale = 1 / scale;

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            
            const x1 = x - dx;
            const y1 = y - dy;

            const x2 = x1 * invScale;
            const y2 = y1 * invScale;

            const srcX = x2 * cosAngle - y2 * sinAngle;
            const srcY = x2 * sinAngle + y2 * cosAngle;
            
            const x_floor = Math.floor(srcX);
            const y_floor = Math.floor(srcY);
            const x_ceil = x_floor + 1;
            const y_ceil = y_floor + 1;
            
            if (x_floor < 0 || x_ceil >= srcWidth || y_floor < 0 || y_ceil >= srcHeight) {
                continue;
            }
            
            const x_ratio = srcX - x_floor;
            const y_ratio = srcY - y_floor;

            const dstIdx = (y * srcWidth + x) * 4;

            for (let channel = 0; channel < 4; channel++) {
                 const c00 = srcData[(y_floor * srcWidth + x_floor) * 4 + channel];
                 const c10 = srcData[(y_floor * srcWidth + x_ceil) * 4 + channel];
                 const c01 = srcData[(y_ceil * srcWidth + x_floor) * 4 + channel];
                 const c11 = srcData[(y_ceil * srcWidth + x_ceil) * 4 + channel];

                 if (c00 === undefined || c10 === undefined || c01 === undefined || c11 === undefined) continue;

                 const c_x0 = c00 * (1 - x_ratio) + c10 * x_ratio;
                 const c_x1 = c01 * (1 - x_ratio) + c11 * x_ratio;

                 dstData[dstIdx + channel] = c_x0 * (1 - y_ratio) + c_x1 * y_ratio;
            }
            if (dstData[dstIdx+3] === 0 && (dstData[dstIdx] > 0 || dstData[dstIdx+1] > 0 || dstData[dstIdx+2] > 0)) {
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
            if (img[i+3] > 0) {
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
        for (let channel = 0; channel < 3; channel++) {
            pixelValues.length = 0;
            for (const img of validImages) {
                if (img[i + 3] > 0) {
                    pixelValues.push(img[i + channel]);
                }
            }
            if (pixelValues.length > 0) {
                pixelValues.sort((a, b) => a - b);
                const mid = Math.floor(pixelValues.length / 2);
                result[i + channel] = pixelValues.length % 2 !== 0
                    ? pixelValues[mid]
                    : (pixelValues[mid - 1] + pixelValues[mid]) / 2;
            }
        }
        
        result[i + 3] = pixelValues.length > 0 ? 255 : 0;
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
        for (let channel = 0; channel < 3; channel++) {
            pixelValues.length = 0;
            for (const img of validImages) {
                if (img[i + 3] > 0) {
                    pixelValues.push(img[i + channel]);
                }
            }

            if (pixelValues.length === 0) continue;
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
        result[i + 3] = pixelValues.length > 0 ? 255 : 0;
    }
    return result;
}


// --- MAIN AI ALIGNMENT & STACKING FUNCTION ---
export async function aiAlignAndStack(
  imageEntries: ImageQueueEntry[],
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
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData!.data];
  
  const refStars = (await findMatchingStars({ allDetectedStars: refEntry.detectedStars, imageData: { data: new Uint8ClampedArray(refEntry.imageData.data.buffer), width, height }, learnedPatterns }))
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
    const targetStars = (await findMatchingStars({ allDetectedStars: targetEntry.detectedStars, imageData: {data: new Uint8ClampedArray(targetData.buffer), width: targetWidth, height: targetHeight }, learnedPatterns }))
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

    const warpedData = warpImage(targetEntry.imageData.data, width, height, transform);
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

    
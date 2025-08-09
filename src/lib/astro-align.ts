

// --- Types ---
export type Point = { x: number; y: number };
export type Star = Point & { brightness: number; size: number };
export type StackingMode = 'average' | 'median' | 'sigma';
export interface ImageQueueEntry {
  id: string;
  imageData: ImageData | null;
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};
export type Transform = {
    dx: number;
    dy: number;
    angle: number;
    scale: number;
};


// --- STAGE 1: ROBUST STAR DETECTION ---

/**
 * Detects bright blobs of pixels to be used as star candidates.
 * A blob is a connected component of pixels where R, G, and B values are all above a certain threshold.
 */
export function detectBrightBlobs(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number = 200
): Star[] {
    const { data } = imageData;
    const visited = new Uint8Array(width * height);
    const stars: Star[] = [];
    const minSize = 3; 
    const maxSize = 500;

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
    
    const isPixelAboveThreshold = (idx: number) => {
        const base = idx * 4;
        return data[base] > threshold && data[base + 1] > threshold && data[base + 2] > threshold;
    }

    for (let i = 0; i < width * height; i++) {
        if (visited[i] || !isPixelAboveThreshold(i)) continue;

        const queue = [i];
        visited[i] = 1;
        const blobPixels: number[] = [];
        
        while (queue.length > 0) {
            const p = queue.shift()!;
            blobPixels.push(p);

            for (const n of getNeighbors(p)) {
                if (!visited[n] && isPixelAboveThreshold(n)) {
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
            const b_idx = p * 4;
            const brightness = (data[b_idx] + data[b_idx+1] + data[b_idx+2]) / 3;
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

// --- STAGE 2: ALIGNMENT ---

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

    // Angle of each vector
    const refAngle = Math.atan2(refVec.y, refVec.x);
    const targetAngle = Math.atan2(targetVec.y, targetVec.x);
    let angle = targetAngle - refAngle;

    // Scale from the lengths of the vectors
    const refDist = Math.sqrt(refVec.x * refVec.x + refVec.y * refVec.y);
    const targetDist = Math.sqrt(targetVec.x * targetVec.x + targetVec.y * targetVec.y);

    // Avoid division by zero
    if (refDist < 1e-6) return null;
    let scale = targetDist / refDist;
    if (scale === 0) return null; // Avoid zero scale

    // Now, consider that the second brightest star might be a different one.
    // Let's test the swapped case.
    const targetVecSwapped = { x: target1.x - target2.x, y: target1.y - target2.y };
    const targetAngleSwapped = Math.atan2(targetVecSwapped.y, targetVecSwapped.x);
    let angleSwapped = targetAngleSwapped - refAngle;
    const targetDistSwapped = Math.sqrt(targetVecSwapped.x*targetVecSwapped.x + targetVecSwapped.y*targetVecSwapped.y);
    let scaleSwapped = targetDistSwapped / refDist;

    // To decide which is better, we can't do much without a third star.
    // However, a simple check could be to see which scale is closer to 1.
    if (Math.abs(scaleSwapped - 1) < Math.abs(scale - 1)) {
        scale = scaleSwapped;
        angle = angleSwapped;
        // The transformation logic needs to handle this swap, aligning target2 to ref1
        const cosAngle = Math.cos(-angle);
        const sinAngle = Math.sin(-angle);
        const rotatedTargetX = target2.x * cosAngle - target2.y * sinAngle;
        const rotatedTargetY = target2.x * sinAngle + target2.y * cosAngle;
        const dx = ref1.x - rotatedTargetX * scale;
        const dy = ref1.y - rotatedTargetY * scale;
        return { dx, dy, angle: -angle, scale };

    }

    // Calculate translation (dx, dy)
    // The translation needs to align target1 to ref1 after rotation and scaling.
    const cosAngle = Math.cos(-angle);
    const sinAngle = Math.sin(-angle);
    
    // Rotate and scale target1's coordinates
    const rotatedTargetX = target1.x * cosAngle - target1.y * sinAngle;
    const rotatedTargetY = target1.x * sinAngle + target1.y * cosAngle;

    // Now calculate the translation needed to move the transformed target1 to ref1
    const dx = ref1.x - rotatedTargetX * scale;
    const dy = ref1.y - rotatedTargetY * scale;

    return { dx, dy, angle: -angle, scale };
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

    if (scale === 0) return dstData; // Prevent division by zero if scale is invalid

    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    
    const invScale = 1 / scale;

    // The center of rotation and scaling should be the reference point, not the canvas center
    // For simplicity with this transform, we'll work with the coordinates directly.

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            
            // Inverse transform: from destination (x,y) to source (srcX, srcY)
            // 1. Inverse translate
            const x1 = x - dx;
            const y1 = y - dy;

            // 2. Inverse scale
            const x2 = x1 * invScale;
            const y2 = y1 * invScale;

            // 3. Inverse rotate
            const srcX = x2 * cosAngle + y2 * sinAngle;
            const srcY = -x2 * sinAngle + y2 * cosAngle;

            // Bilinear interpolation
            const x_floor = Math.floor(srcX);
            const y_floor = Math.floor(srcY);
            const x_ceil = x_floor + 1;
            const y_ceil = y_floor + 1;
            
            if (x_floor < 0 || x_ceil >= srcWidth || y_floor < 0 || y_ceil >= srcHeight) {
                continue; // Out of bounds
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
            // Set alpha to full for pixels that get data
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
            // Check if pixel has data (not black from warping)
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
            } else { // If all pixels are outliers, use median
                 pixelValues.sort((a,b) => a-b);
                 const mid = Math.floor(pixelValues.length / 2);
                 result[i + channel] = pixelValues.length % 2 !== 0 ? pixelValues[mid] : (pixelValues[mid - 1] + pixelValues[mid]) / 2;
            }
        }
        result[i + 3] = pixelValues.length > 0 ? 255 : 0;
    }
    return result;
}


// --- MAIN ALIGNMENT & STACKING FUNCTION ---
export async function alignAndStack(
  imageEntries: ImageQueueEntry[],
  manualRefStars: Star[],
  mode: StackingMode,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  if (imageEntries.length === 0 || !imageEntries[0].imageData) {
    throw new Error("No valid images provided for stacking.");
  }

  const refEntry = imageEntries[0];
  const { width, height } = refEntry.analysisDimensions;
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData!.data];
  
  const refStars = (manualRefStars.length > 1 ? manualRefStars : refEntry.detectedStars)
      .sort((a, b) => b.brightness - a.brightness)
      .slice(0, 50);

  if (refStars.length < 2) {
    throw new Error("Reference image has fewer than 2 detected stars. Cannot align.");
  }

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    const progress = (i + 1) / imageEntries.length;

    if (!targetEntry.imageData) {
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }

    const targetStars = targetEntry.detectedStars
        .sort((a, b) => b.brightness - a.brightness)
        .slice(0, 50);

    if (targetStars.length < 2) {
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }

    const transform = getTransformFromTwoStars(refStars, targetStars);

    if (!transform) {
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }
    
    const warpedData = warpImage(targetEntry.imageData.data, width, height, transform);
    alignedImageDatas.push(warpedData);
    
    setProgress(progress);
  }

  setProgress(1);

  switch (mode) {
    case 'median':
        return stackImagesMedian(alignedImageDatas);
    case 'sigma':
        return stackImagesSigmaClip(alignedImageDatas);
    case 'average':
    default:
        return stackImagesAverage(alignedImageDatas);
  }
}

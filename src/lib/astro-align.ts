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
 * Detects stars using a simple blob detection and center-of-mass calculation.
 */
export function detectStars(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number
): Star[] {
    const gray = toGrayscale(imageData);
    const visited = new Uint8Array(gray.length);
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

    for (let i = 0; i < gray.length; i++) {
        if (visited[i] || gray[i] < threshold) continue;

        const queue = [i];
        visited[i] = 1;
        const blobPixels: number[] = [];
        
        while (queue.length > 0) {
            const p = queue.shift()!;
            blobPixels.push(p);

            for (const n of getNeighbors(p)) {
                if (!visited[n] && gray[n] >= threshold - 20) {
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
    const angle = targetAngle - refAngle;

    // Scale from the lengths of the vectors
    const refDist = Math.sqrt(refVec.x * refVec.x + refVec.y * refVec.y);
    const targetDist = Math.sqrt(targetVec.x * targetVec.x + targetVec.y * targetVec.y);

    // Avoid division by zero
    if (refDist < 1e-6) return null;
    const scale = targetDist / refDist;

    // Calculate translation (dx, dy)
    // The translation needs to align target1 to ref1 after rotation and scaling.
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);

    const dx = ref1.x - (target1.x * scale * cosAngle - target1.y * scale * sinAngle);
    const dy = ref1.y - (target1.x * scale * sinAngle + target1.y * scale * cosAngle);

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

    const cosAngle = Math.cos(-angle);
    const sinAngle = Math.sin(-angle);
    
    const invScale = 1 / scale;

    const centerX = srcWidth / 2;
    const centerY = srcHeight / 2;

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            // Apply inverse transform from destination (x,y) to find source (srcX, srcY)
            
            // 1. Inverse translate to origin
            const x1 = x - dx - centerX;
            const y1 = y - dy - centerY;

            // 2. Inverse rotate
            const x2 = x1 * cosAngle - y1 * sinAngle;
            const y2 = x1 * sinAngle + y1 * cosAngle;

            // 3. Inverse scale
            const srcX = x2 * invScale + centerX;
            const srcY = y2 * invScale + centerY;

            // Bilinear interpolation
            const x0 = Math.floor(srcX);
            const y0 = Math.floor(srcY);
            const x1_ = Math.ceil(srcX);
            const y1_ = Math.ceil(srcY);

            if (x0 < 0 || x1_ >= srcWidth || y0 < 0 || y1_ >= srcHeight) {
                continue; // Out of bounds
            }
            
            const x_ratio = srcX - x0;
            const y_ratio = srcY - y0;

            const dstIdx = (y * srcWidth + x) * 4;

            for (let channel = 0; channel < 4; channel++) {
                 const c00 = srcData[(y0 * srcWidth + x0) * 4 + channel];
                 const c10 = srcData[(y0 * srcWidth + x1_) * 4 + channel];
                 const c01 = srcData[(y1_ * srcWidth + x0) * 4 + channel];
                 const c11 = srcData[(y1_ * srcWidth + x1_) * 4 + channel];

                 const c_x0 = c00 * (1 - x_ratio) + c10 * x_ratio;
                 const c_x1 = c01 * (1 - x_ratio) + c11 * x_ratio;

                 dstData[dstIdx + channel] = c_x0 * (1-y_ratio) + c_x1 * y_ratio;
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
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  if (imageEntries.length === 0 || !imageEntries[0].imageData) {
    throw new Error("No valid images provided for stacking.");
  }

  const refEntry = imageEntries[0];
  const { width, height } = refEntry.analysisDimensions;
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData!.data];
  
  const refStars = (manualRefStars.length > 1 ? manualRefStars : refEntry.detectedStars);

  if (refStars.length < 2) {
    addLog(`Error: Reference image has fewer than 2 stars. Cannot align.`);
    throw new Error("Reference image has fewer than 2 stars. Cannot align.");
  }
  addLog(`Using ${refStars.length} stars from reference image.`);

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    const progress = (i + 1) / imageEntries.length;
    addLog(`--- Aligning Image ${i+1}/${imageEntries.length} ---`);

    if (!targetEntry.imageData) {
      addLog(`Skipping image ${i+1}: missing image data.`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }

    const targetStars = targetEntry.detectedStars;
    if (targetStars.length < 2) {
        addLog(`Skipping image ${i+1}: fewer than 2 stars detected.`);
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }

    const transform = getTransformFromTwoStars(refStars, targetStars);

    if (!transform) {
        addLog(`Skipping image ${i+1}: could not determine robust transform.`);
        alignedImageDatas.push(null);
        setProgress(progress);
        continue;
    }
    
    addLog(`Image ${i+1}: Applying transform (dx: ${transform.dx.toFixed(2)}, dy: ${transform.dy.toFixed(2)}, angle: ${(transform.angle * 180 / Math.PI).toFixed(3)}°, scale: ${transform.scale.toFixed(3)})`);

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


// --- Types ---
import { matrix, inv, multiply, transpose, lusolve, median, mean, std, eigs } from 'mathjs';

export type Point = { x: number; y: number };
export type Star = Point & { brightness: number; size: number; fwhm: number };
export type StackingMode = 'average' | 'median' | 'sigma';
export interface ImageQueueEntry {
  id: string;
  imageData: ImageData | null;
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};

// --- UTILITY FUNCTIONS ---
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

function euclideanDist(p1: Point, p2: Point): number {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
}


// --- STAGE 1: STAR DETECTION with PSF ---

/**
 * Fits a 2D Gaussian function to a small patch of an image to find the sub-pixel center of a star.
 * Returns null if the fit is not valid or doesn't represent a star-like object.
 */
function fitGaussianPSF(
  gray: Uint8Array,
  width: number,
  height: number,
  blob: { pixels: number[]; peakValue: number }
): { x: number; y: number; fwhm: number; amplitude: number; } | null {
  if (blob.pixels.length < 5) return null; // Need enough points for a stable fit

  const initialX = blob.pixels.reduce((sum, p) => sum + (p % width), 0) / blob.pixels.length;
  const initialY = blob.pixels.reduce((sum, p) => sum + Math.floor(p / width), 0) / blob.pixels.length;

  const patchRadius = Math.ceil(Math.sqrt(blob.pixels.length / Math.PI)) + 2;

  const patchPixels: { x: number, y: number, value: number }[] = [];
  let minVal = 255;
  let hasSignal = false;

  for (const p of blob.pixels) {
    const x = p % width;
    const y = Math.floor(p / width);
    if (Math.abs(x - initialX) <= patchRadius && Math.abs(y - initialY) <= patchRadius) {
        const value = gray[p];
        patchPixels.push({ x, y, value });
        if (value < minVal) minVal = value;
        if (value > minVal + 5) hasSignal = true;
    }
  }
  
  if (patchPixels.length < 6 || !hasSignal) return null;

  const A: number[][] = [];
  const b: number[] = [];

  for (const p of patchPixels) {
    const x = p.x;
    const y = p.y;
    const val = p.value - minVal;
    if (val > 0) {
      A.push([x * x, y * y, x * y, x, y, 1]);
      b.push(Math.log(val));
    }
  }

  if (A.length < 6) return null;

  try {
    const At = transpose(A);
    let AtA = multiply(At, A);
    
    // Regularization: add a small identity matrix to prevent singularity
    const regularizedAtA = matrix(AtA.valueOf());
    for(let i=0; i<regularizedAtA.size()[0]; ++i){
        (regularizedAtA as any)._data[i][i] += 1e-6;
    }

    const Atb = multiply(At, b);
    const coeffs = lusolve(regularizedAtA, Atb).valueOf().flat() as number[];

    const [c_xx, c_yy, c_xy, c_x, c_y, c_logA] = coeffs;

    const M = matrix([[c_xx, c_xy / 2], [c_xy / 2, c_yy]]);
    const V = matrix([[-c_x], [-c_y]]);
    
    const centerOffset = multiply(inv(M), V).valueOf() as [[number], [number]];
    const x_center = centerOffset[0][0] / 2;
    const y_center = centerOffset[1][0] / 2;
    
    if (isNaN(x_center) || isNaN(y_center) || Math.abs(x_center - initialX) > patchRadius || Math.abs(y_center - initialY) > patchRadius) {
      return null;
    }

    const amplitude = Math.exp(c_logA - (c_xx * x_center * x_center) - (c_yy * y_center * y_center) - (c_xy * x_center * y_center));
    
    const eigenvalues = (eigs(multiply(M, -2)) as any).values.valueOf() as number[];
    if (eigenvalues.some(e => e <= 0)) return null;

    const fwhm1 = 2 * Math.sqrt(2 * Math.log(2) / eigenvalues[0]);
    const fwhm2 = 2 * Math.sqrt(2 * Math.log(2) / eigenvalues[1]);
    const fwhm = (fwhm1 + fwhm2) / 2;
    
    if (isNaN(fwhm) || fwhm < 1.0 || fwhm > patchRadius * 2) return null;

    return { x: x_center, y: y_center, fwhm, amplitude };

  } catch (e) {
    return null;
  }
}

/**
 * Detects stars in an image using blob detection followed by a PSF fit for sub-pixel accuracy.
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
        let peakValue = 0;

        while (queue.length > 0) {
            const p = queue.shift()!;
            blobPixels.push(p);
            const brightness = gray[p];
            if(brightness > peakValue) peakValue = brightness;

            for (const n of getNeighbors(p)) {
                if (!visited[n] && gray[n] >= threshold - 10) { // Slightly lower threshold for neighbors
                    visited[n] = 1;
                    queue.push(n);
                }
            }
        }
        
        const fitResult = fitGaussianPSF(gray, width, height, { pixels: blobPixels, peakValue });

        if (fitResult) {
            stars.push({
                x: fitResult.x,
                y: fitResult.y,
                brightness: fitResult.amplitude,
                size: blobPixels.length,
                fwhm: fitResult.fwhm,
            });
        }
    }

    return stars.sort((a, b) => b.brightness - a.brightness);
}

// --- STAGE 2: TRIANGLE-BASED PATTERN MATCHING ---

interface Triangle {
    indices: [number, number, number];
    hash: string;
}

/**
 * Creates a list of rotation/scale/translation invariant triangles from a list of stars.
 */
function createStarTriangles(stars: Star[]): Triangle[] {
    const triangles: Triangle[] = [];
    if (stars.length < 3) return [];

    // Use only top 50 brightest stars for pattern creation to reduce complexity and improve reliability
    const starCandidates = stars.slice(0, 50);

    for (let i = 0; i < starCandidates.length; i++) {
        for (let j = i + 1; j < starCandidates.length; j++) {
            for (let k = j + 1; k < starCandidates.length; k++) {
                const s1 = starCandidates[i];
                const s2 = starCandidates[j];
                const s3 = starCandidates[k];

                const sides = [
                    euclideanDist(s2, s3),
                    euclideanDist(s1, s3),
                    euclideanDist(s1, s2)
                ].sort((a, b) => a - b);

                if (sides[0] < 1e-6) continue; // Degenerate triangle

                // Hash is based on the ratio of the side lengths, making it scale-invariant
                const ratio1 = sides[1] / sides[0];
                const ratio2 = sides[2] / sides[0];
                const hash = `${ratio1.toFixed(3)}:${ratio2.toFixed(3)}`;

                triangles.push({ indices: [i, j, k], hash });
            }
        }
    }
    return triangles;
}


// --- STAGE 3: FIND TRANSFORMATION ---

/**
 * Finds the similarity transform between two sets of stars using triangle matching.
 */
function findTransform(refStars: Star[], targetStars: Star[]): { scale: number; rotation: number; translation: Point } | null {
    if (refStars.length < 3 || targetStars.length < 3) return null;
    const refTriangles = createStarTriangles(refStars);
    const targetTriangles = createStarTriangles(targetStars);

    const triangleMap = new Map<string, Triangle[]>();
    for (const tri of targetTriangles) {
        if (!triangleMap.has(tri.hash)) {
            triangleMap.set(tri.hash, []);
        }
        triangleMap.get(tri.hash)!.push(tri);
    }

    const correspondences: { p1: Point; p2: Point }[] = [];
    for (const refTri of refTriangles) {
        if (triangleMap.has(refTri.hash)) {
            const matchedTargetTris = triangleMap.get(refTri.hash)!;
            for (const targetTri of matchedTargetTris) {
                 // Create correspondences for all 3 vertices of the matched triangles
                for (let i = 0; i < 3; i++) {
                    correspondences.push({
                        p1: refStars[refTri.indices[i]],
                        p2: targetStars[targetTri.indices[i]]
                    });
                }
            }
        }
    }

    if (correspondences.length < 3) return null;

    // RANSAC to find best transform from correspondences
    return estimateSimilarityTransformRANSAC(
        correspondences.map(c => c.p1),
        correspondences.map(c => c.p2),
        100, // iterations
        2.0  // threshold in pixels
    );
}

// --- RANSAC & GEOMETRY HELPERS ---

function estimateSimilarityTransform(points1: Point[], points2: Point[]): { scale: number; rotation: number; translation: Point } | null {
  if (points1.length < 2 || points2.length < 2) return null;
  const n = points1.length;
  let centroid1 = { x: 0, y: 0 }, centroid2 = { x: 0, y: 0 };
  points1.forEach(p => { centroid1.x += p.x; centroid1.y += p.y; });
  points2.forEach(p => { centroid2.x += p.x; centroid2.y += p.y; });
  centroid1.x /= n; centroid1.y /= n;
  centroid2.x /= n; centroid2.y /= n;

  const centered1 = points1.map(p => ({ x: p.x - centroid1.x, y: p.y - centroid1.y }));
  const centered2 = points2.map(p => ({ x: p.x - centroid2.x, y: p.y - centroid2.y }));

  let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0;
  for (let i = 0; i < n; i++) {
      Sxx += centered1[i].x * centered2[i].x;
      Sxy += centered1[i].x * centered2[i].y;
      Syx += centered1[i].y * centered2[i].x;
      Syy += centered1[i].y * centered2[i].y;
  }
  
  const N = Sxx + Syy;
  const M = Syx - Sxy;

  let sum_sq_centered1 = 0;
  for(let i=0; i<n; ++i) {
      sum_sq_centered1 += centered1[i].x*centered1[i].x + centered1[i].y*centered1[i].y;
  }
  if (sum_sq_centered1 <= 1e-9) return null;

  const scale = Math.sqrt(N * N + M * M) / sum_sq_centered1;
  const rotation = Math.atan2(M, N);
  
  const translation = {
      x: centroid2.x - (centroid1.x * scale * Math.cos(rotation) - centroid1.y * scale * Math.sin(rotation)),
      y: centroid2.y - (centroid1.x * scale * Math.sin(rotation) + centroid1.y * scale * Math.cos(rotation)),
  };

  return { scale, rotation, translation };
}


function estimateSimilarityTransformRANSAC(
    points1: Point[],
    points2: Point[],
    iterations = 100,
    threshold = 2.0
): { scale: number; rotation: number; translation: Point } | null {
    if (points1.length < 3) return null;
    let bestInliers: number[] = [];

    for (let iter = 0; iter < iterations; iter++) {
        const indices: number[] = [];
        while (indices.length < 2) {
            const idx = Math.floor(Math.random() * points1.length);
            if (!indices.includes(idx)) indices.push(idx);
        }
        const samplePoints1 = indices.map(i => points1[i]);
        const samplePoints2 = indices.map(i => points2[i]);
        
        const candidate = estimateSimilarityTransform(samplePoints1, samplePoints2);
        if (!candidate) continue;

        const inliers: number[] = [];
        for (let i = 0; i < points1.length; i++) {
            const warped = warpPoint(points1[i], candidate);
            if (euclideanDist(warped, points2[i]) < threshold) {
                inliers.push(i);
            }
        }

        if (inliers.length > bestInliers.length) {
            bestInliers = inliers;
        }
    }

    if (bestInliers.length < 3) return null;

    const inlierPoints1 = bestInliers.map(i => points1[i]);
    const inlierPoints2 = bestInliers.map(i => points2[i]);
    
    return estimateSimilarityTransform(inlierPoints1, inlierPoints2);
}


function warpPoint(p: Point, params: { scale: number; rotation: number; translation: Point }): Point {
  const { scale, rotation, translation } = params;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  return {
    x: scale * (cosR * p.x - sinR * p.y) + translation.x,
    y: scale * (sinR * p.x + cosR * p.y) + translation.y,
  };
}


function warpImage(
    srcData: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    transform: { scale: number; rotation: number; translation: Point }
): Uint8ClampedArray {
    const dstData = new Uint8ClampedArray(srcData.length);
    if (Math.abs(transform.scale) < 1e-9) return dstData;

    const cosR = Math.cos(-transform.rotation);
    const sinR = Math.sin(-transform.rotation);
    const invScale = 1.0 / transform.scale;
    const tX = transform.translation.x;
    const tY = transform.translation.y;

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            const dstIdx = (y * srcWidth + x) * 4;

            // Apply inverse transformation to find corresponding source pixel
            const srcX_unscaled = (x - tX) * cosR - (y - tY) * sinR;
            const srcY_unscaled = (x - tX) * sinR + (y - tY) * cosR;
            const srcX = srcX_unscaled * invScale;
            const srcY = srcY_unscaled * invScale;

            if (srcX < 0 || srcX >= srcWidth - 1 || srcY < 0 || srcY >= srcHeight - 1) {
                continue; // Pixel is outside the source image bounds
            }
            
            // Bilinear interpolation
            const x0 = Math.floor(srcX);
            const y0 = Math.floor(srcY);
            const x1 = x0 + 1;
            const y1 = y0 + 1;
            const x_frac = srcX - x0;
            const y_frac = srcY - y0;

            for (let channel = 0; channel < 3; channel++) {
                const c00 = srcData[(y0 * srcWidth + x0) * 4 + channel];
                const c10 = srcData[(y0 * srcWidth + x1) * 4 + channel];
                const c01 = srcData[(y1 * srcWidth + x0) * 4 + channel];
                const c11 = srcData[(y1 * srcWidth + x1) * 4 + channel];
                
                const top = c00 * (1 - x_frac) + c10 * x_frac;
                const bottom = c01 * (1 - x_frac) + c11 * x_frac;
                const val = top * (1 - y_frac) + bottom * y_frac;
                
                dstData[dstIdx + channel] = val;
            }
            dstData[dstIdx + 3] = 255; // Set alpha to fully opaque
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
            if (img[i + 3] > 128) {
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
                if (img[i + 3] > 128) {
                    pixelValues.push(img[i + channel]);
                }
            }
            if (pixelValues.length > 2) {
                result[i + channel] = median(pixelValues);
            } else if (pixelValues.length > 0) {
                 result[i + channel] = pixelValues.reduce((a, b) => a + b, 0) / pixelValues.length;
            }
        }
        
        const validCount = validImages.filter(img => img[i+3] > 128).length;
        result[i + 3] = validCount > 0 ? 255 : 0;
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
                if (img[i + 3] > 128) {
                    pixelValues.push(img[i + channel]);
                }
            }

            if (pixelValues.length < 3) {
                if (pixelValues.length > 0) {
                    result[i + channel] = pixelValues.reduce((a, b) => a + b, 0) / pixelValues.length;
                }
                continue;
            }
            
            const mu = mean(pixelValues);
            const stdev = std(pixelValues);
            if (stdev === 0) {
                 result[i + channel] = mu;
                 continue;
            }

            const threshold = sigma * stdev;
            const filtered = pixelValues.filter(v => Math.abs(v - mu) < threshold);
            
            if (filtered.length > 0) {
                result[i + channel] = filtered.reduce((a, b) => a + b, 0) / filtered.length;
            } else {
                 result[i + channel] = median(pixelValues);
            }
        }
        const validCount = validImages.filter(img => img[i+3] > 128).length;
        result[i + 3] = validCount > 0 ? 255 : 0;
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
    throw new Error("No valid images provided.");
  }

  const refEntry = imageEntries[0];
  const { width, height } = refEntry.analysisDimensions;
  const alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData!.data];
  
  const refStars = refEntry.detectedStars;
  
  if (refStars.length < 3) {
    addLog(`Error: Reference image has fewer than 3 stars (${refStars.length}). Cannot proceed with alignment.`);
    if(imageEntries.length === 1) return refEntry.imageData!.data;
    throw new Error("Reference image has too few stars to align the stack.");
  }

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
    if (targetEntry.detectedStars.length < 3) {
      addLog(`Skipping image ${i+1}: not enough stars detected (${targetEntry.detectedStars.length}).`);
      alignedImageDatas.push(null);
      setProgress(progress);
      continue;
    }

    const targetStars = targetEntry.detectedStars;
    const finalTransform = findTransform(refStars, targetStars);
      
    if (finalTransform) {
      addLog(`Image ${i+1}: Found transform: S: ${finalTransform.scale.toFixed(4)}, R: ${(finalTransform.rotation * 180 / Math.PI).toFixed(4)}°, T:(${finalTransform.translation.x.toFixed(2)}, ${finalTransform.translation.y.toFixed(2)})`);
      const warpedData = warpImage(targetEntry.imageData.data, width, height, finalTransform);
      alignedImageDatas.push(warpedData);
    } else {
      addLog(`Skipping image ${i+1}: Could not determine robust transform.`);
      alignedImageDatas.push(null);
    }
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

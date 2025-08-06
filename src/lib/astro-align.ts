// --- Types ---
import { lusolve, multiply, transpose, inv, matrix, Matrix, eigs, abs } from 'mathjs';

export type Point = { x: number; y: number };
export type Star = Point & { brightness: number; size: number; fwhm: number, descriptor: number[] };
export type ImageQueueEntry = {
  imageData: ImageData | null;
  detectedStars: Star[];
};


// --- 1) Grayscale conversion & Pre-processing ---
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

// --- 2) Blob detection (for candidacy) + PSF fitting ---

function fitGaussianPSF(patch: number[][], initialX: number, initialY: number): { x: number, y: number, brightness: number, fwhm: number } | null {
    const size = patch.length;
    if (size === 0) return null;
    const halfSize = Math.floor(size / 2);

    let A = [];
    let b = [];

    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            const x = c - halfSize;
            const y = r - halfSize;
            const z = patch[r][c];
            if (z > 0) { // Only fit points with signal
                const log_z = Math.log(z);
                A.push([x * x, y * y, x * y, x, y, 1]);
                b.push(log_z);
            }
        }
    }

    if (A.length < 6) return null; // Not enough points to solve

    try {
        const At = transpose(matrix(A));
        const AtA = multiply(At, matrix(A));
        const Atb = multiply(At, matrix(b));
        const coeffs = lusolve(AtA, Atb).toArray().flat() as number[];

        const [c_xx, c_yy, c_xy, c_x, c_y, c_0] = coeffs;

        if (c_xx >= 0 || c_yy >= 0) return null; // Not a peak

        const q = 4 * c_xx * c_yy - c_xy * c_xy;
        if (q <= 0) return null; // Not an ellipse

        const x_center = (c_xy * c_y - 2 * c_yy * c_x) / q;
        const y_center = (c_xy * c_x - 2 * c_xx * c_y) / q;

        const brightness = Math.exp(c_0 + (c_x * x_center + c_y * y_center) / 2);
        
        const fwhm = Math.sqrt(-2 * Math.log(0.5) * (c_xx + c_yy + Math.sqrt(Math.pow(c_xx - c_yy, 2) + c_xy*c_xy)) / (c_xx * c_yy - c_xy*c_xy/4)) * 2;


        if (Math.abs(x_center) > halfSize || Math.abs(y_center) > halfSize) {
          return null; // Center is outside the patch, likely a bad fit
        }

        return {
            x: initialX + x_center,
            y: initialY + y_center,
            brightness,
            fwhm,
        };

    } catch (error) {
        // console.error("Gaussian fit failed:", error);
        return null;
    }
}


function detectStars(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  minSize = 3,
  maxSize = 100 
): Star[] {
  const visited = new Uint8Array(gray.length);
  const stars: Star[] = [];
  const psfPatchSize = 7; // e.g., 7x7 patch
  const halfPsfPatchSize = Math.floor(psfPatchSize / 2);

  function neighbors(pos: number): number[] {
    const neighbors = [];
    const x = pos % width;
    const y = Math.floor(pos / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) neighbors.push(ny * width + nx);
      }
    }
    return neighbors;
  }

  function computeDescriptor(cx: number, cy: number): number[] {
    const patch: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x >= 0 && x < width && y >= 0 && y < height) {
          patch.push(gray[y * width + x] / 255);
        } else {
          patch.push(0);
        }
      }
    }
    return patch;
  }
  
  for (let i = 0; i < gray.length; i++) {
    if (visited[i] || gray[i] < threshold) continue;

    const queue = [i];
    visited[i] = 1;
    let blobPixels = [];
    let sumX = 0, sumY = 0, count = 0;

    while (queue.length > 0) {
      const p = queue.shift()!;
      const x = p % width;
      const y = Math.floor(p / width);
      
      blobPixels.push({x,y});
      sumX += x;
      sumY += y;
      count++;
      
      for (const n of neighbors(p)) {
        if (!visited[n] && gray[n] >= threshold) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }
    
    if (count >= minSize && count <= maxSize) {
        const approxCx = sumX / count;
        const approxCy = sumY / count;

        if (approxCx > halfPsfPatchSize && approxCx < width - halfPsfPatchSize &&
            approxCy > halfPsfPatchSize && approxCy < height - halfPsfPatchSize) {
            
            const patch: number[][] = Array(psfPatchSize).fill(0).map(() => Array(psfPatchSize).fill(0));
            let patchMax = 0;

            for (let r = 0; r < psfPatchSize; r++) {
                for (let c = 0; c < psfPatchSize; c++) {
                    const sampleX = Math.round(approxCx) - halfPsfPatchSize + c;
                    const sampleY = Math.round(approxCy) - halfPsfPatchSize + r;
                    const val = gray[sampleY * width + sampleX];
                    patch[r][c] = val;
                    if (val > patchMax) patchMax = val;
                }
            }
            
            if (patchMax < threshold * 1.5) continue; // Skip if peak is not significantly above threshold

            const fitResult = fitGaussianPSF(patch, approxCx, approxCy);

            if (fitResult && fitResult.fwhm > 0.5 && fitResult.fwhm < psfPatchSize) { // Sanity checks
                const desc = computeDescriptor(fitResult.x, fitResult.y);
                stars.push({
                    x: fitResult.x,
                    y: fitResult.y,
                    brightness: fitResult.brightness,
                    size: count, // Keep blob size for potential filtering
                    fwhm: fitResult.fwhm,
                    descriptor: desc
                });
            }
        }
    }
  }
  return stars;
}


// --- 3) Multi-scale detection (simple 2x downscale) ---
export function detectStarsMultiScale(
  imageData: ImageData,
  width: number,
  height: number,
  threshold: number
): Star[] {
  const gray = toGrayscale(imageData);
  const starsScale1 = detectStars(gray, width, height, threshold, 3);
  
  const width2 = Math.floor(width / 2);
  const height2 = Math.floor(height / 2);
  const gray2 = new Uint8Array(width2 * height2);
  for (let y = 0; y < height2; y++) {
    for (let x = 0; x < width2; x++) {
      const sum =
        gray[y * 2 * width + x * 2] +
        gray[y * 2 * width + x * 2 + 1] +
        gray[(y * 2 + 1) * width + x * 2] +
        gray[(y * 2 + 1) * width + x * 2 + 1];
      gray2[y * width2 + x] = Math.floor(sum / 4);
    }
  }
  const starsScale2Raw = detectStars(gray2, width2, height2, threshold, 3);
  const starsScale2 = starsScale2Raw.map(s => ({ ...s, x: s.x * 2, y: s.y * 2 }));
  
  const combined: Star[] = [...starsScale1];
  for (const s2 of starsScale2) {
    if (!combined.some(s1 => euclideanDist(s1, s2) < 5)) {
      combined.push(s2);
    }
  }
  return combined;
}

// --- 4) Euclidean distance ---
function euclideanDist(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x, dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- 5) Descriptor distance ---
function descriptorDist(d1: number[], d2: number[]): number {
  let sum = 0;
  for (let i = 0; i < d1.length; i++) {
    const diff = d1[i] - d2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// --- 6) KD-tree for stars ---
class KDNode {
    point: Star;
    left: KDNode | null = null;
    right: KDNode | null = null;
    axis: 0 | 1;
    constructor(points: Star[], depth = 0) {
      this.axis = (depth % 2) as 0 | 1;
      points.sort((a, b) => (this.axis === 0 ? a.x - b.x : a.y - b.y));
      const median = Math.floor(points.length / 2);
      this.point = points[median];
      if (median > 0) this.left = points.slice(0, median).length > 0 ? new KDNode(points.slice(0, median), depth + 1) : null;
      if (median + 1 < points.length) this.right = points.slice(median + 1).length > 0 ? new KDNode(points.slice(median + 1), depth + 1) : null;
    }
    nearest(point: Point, best: { star: Star | null; dist: number }, maxDist: number): { star: Star | null; dist: number } {
      if (!this.point) return best;
      const d = euclideanDist(this.point, point);
      if (d < best.dist && d < maxDist) {
        best.star = this.point;
        best.dist = d;
      }
      const diff = this.axis === 0 ? point.x - this.point.x : point.y - this.point.y;
      const first = diff < 0 ? this.left : this.right;
      const second = diff < 0 ? this.right : this.left;
      if (first) best = first.nearest(point, best, maxDist);
      if (second && Math.abs(diff) < best.dist) best = second.nearest(point, best, maxDist);
      return best;
    }
  }

// --- 7) Feature matching with kd-tree + ratio test ---
function matchFeatures(
  stars1: Star[],
  stars2: Star[],
  maxDistance = 15,
  descriptorThreshold = 0.4
): [Star, Star][] {
  if (stars2.length === 0) return [];
  const tree = new KDNode(stars2);
  const matches: [Star, Star][] = [];
  for (const s1 of stars1) {
    const bestNeighbor = tree.nearest(s1, { star: null, dist: maxDistance }, maxDistance);
    if (!bestNeighbor.star) continue;
    const dDist = descriptorDist(s1.descriptor, bestNeighbor.star.descriptor);
    if (dDist > descriptorThreshold) continue;
    
    let secondDist = Infinity;
    for (const s2 of stars2) {
      if (s2 === bestNeighbor.star) continue;
      if (euclideanDist(s1, s2) > maxDistance) continue;
      const descD = descriptorDist(s1.descriptor, s2.descriptor);
      if (descD < secondDist) secondDist = descD;
    }
    if (secondDist > 0 && dDist / secondDist < 0.75) {
      matches.push([s1, bestNeighbor.star]);
    }
  }
  return matches;
}

// --- 8) Estimate similarity transform ---
function estimateSimilarityTransform(
  points1: Point[],
  points2: Point[]
): { scale: number; rotation: number; translation: Point } | null {
  if (points1.length < 2 || points2.length < 2) return null;
  const n = Math.min(points1.length, points2.length);
  const centroid1 = points1.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  const centroid2 = points2.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  centroid1.x /= n; centroid1.y /= n;
  centroid2.x /= n; centroid2.y /= n;

  const centered1 = points1.map(p => ({ x: p.x - centroid1.x, y: p.y - centroid1.y }));
  const centered2 = points2.map(p => ({ x: p.x - centroid2.x, y: p.y - centroid2.y }));

  let var1 = 0, cov_xx = 0, cov_xy = 0, cov_yx = 0, cov_yy = 0;
  for (let i = 0; i < n; i++) {
    var1 += centered1[i].x * centered1[i].x + centered1[i].y * centered1[i].y;
    cov_xx += centered2[i].x * centered1[i].x;
    cov_xy += centered2[i].x * centered1[i].y;
    cov_yx += centered2[i].y * centered1[i].x;
    cov_yy += centered2[i].y * centered1[i].y;
  }
  if (var1 === 0) return null;

  const a = cov_xx + cov_yy;
  const b = cov_yx - cov_xy;
  const scale = Math.sqrt(a * a + b * b) / var1;
  const rotation = Math.atan2(b, a);
  const translation = {
    x: centroid2.x - scale * (Math.cos(rotation) * centroid1.x - Math.sin(rotation) * centroid1.y),
    y: centroid2.y - scale * (Math.sin(rotation) * centroid1.x + Math.cos(rotation) * centroid1.y),
  };
  return { scale, rotation, translation };
}

// --- 9) RANSAC to robustly estimate similarity transform ---
function estimateSimilarityTransformRANSAC(
  points1: Point[],
  points2: Point[],
  iterations = 100,
  threshold = 3
): { scale: number; rotation: number; translation: Point } | null {
  if (points1.length < 3 || points2.length < 3) return null;
  let bestInliers: number[] = [];
  let bestTransform: ReturnType<typeof estimateSimilarityTransform> | null = null;
  for (let iter = 0; iter < iterations; iter++) {
    const idx1 = Math.floor(Math.random() * points1.length);
    let idx2 = Math.floor(Math.random() * points1.length);
    while (idx2 === idx1) idx2 = Math.floor(Math.random() * points1.length);
    const samplePoints1 = [points1[idx1], points1[idx2]];
    const samplePoints2 = [points2[idx1], points2[idx2]];
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
      bestTransform = candidate;
    }
  }
  if (bestInliers.length < 3 || !bestTransform) return null;
  const inlierPoints1 = bestInliers.map(i => points1[i]);
  const inlierPoints2 = bestInliers.map(i => points2[i]);
  return estimateSimilarityTransform(inlierPoints1, inlierPoints2);
}

// --- 10) Warp a single point ---
function warpPoint(p: Point, params: { scale: number; rotation: number; translation: Point }): Point {
  const { scale, rotation, translation } = params;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  return {
    x: scale * (cosR * p.x - sinR * p.y) + translation.x,
    y: scale * (sinR * p.x + cosR * p.y) + translation.y,
  };
}

// --- 11) Warp image with BILINEAR INTERPOLATION ---
function warpImage(
    srcData: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    transform: { scale: number; rotation: number; translation: Point }
): Uint8ClampedArray {
    const dstData = new Uint8ClampedArray(srcData.length);
    const cosR = Math.cos(-transform.rotation);
    const sinR = Math.sin(-transform.rotation);
    if (transform.scale === 0) return dstData;
    const invScale = 1 / transform.scale;

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            const dstIdx = (y * srcWidth + x) * 4;

            const dx = x - transform.translation.x;
            const dy = y - transform.translation.y;
            const srcX = invScale * (cosR * dx - sinR * dy);
            const srcY = invScale * (sinR * dx + cosR * dy);
            
            const x0 = Math.floor(srcX);
            const y0 = Math.floor(srcY);
            
            if (x0 >= 0 && x0 < srcWidth - 1 && y0 >= 0 && y0 < srcHeight - 1) {
                const x1 = x0 + 1;
                const y1 = y0 + 1;
                const x_frac = srcX - x0;
                const y_frac = srcY - y0;
                const c00_idx = (y0 * srcWidth + x0) * 4;
                const c00_alpha = srcData[c00_idx + 3];

                if (c00_alpha === 0) { 
                    continue;
                }

                for (let channel = 0; channel < 3; channel++) { // Only R, G, B
                    const c00 = srcData[c00_idx + channel];
                    const c10 = srcData[(y0 * srcWidth + x1) * 4 + channel];
                    const c01 = srcData[(y1 * srcWidth + x0) * 4 + channel];
                    const c11 = srcData[(y1 * srcWidth + x1) * 4 + channel];
                    
                    const top = c00 * (1 - x_frac) + c10 * x_frac;
                    const bottom = c01 * (1 - x_frac) + c11 * x_frac;
                    const val = top * (1 - y_frac) + bottom * y_frac;
                    
                    dstData[dstIdx + channel] = val;
                }
                dstData[dstIdx + 3] = c00_alpha; // Use nearest-neighbor for alpha
            } else {
                 dstData[dstIdx] = 0;
                 dstData[dstIdx + 1] = 0;
                 dstData[dstIdx + 2] = 0;
                 dstData[dstIdx + 3] = 0;
            }
        }
    }
    return dstData;
}


// --- 12) Stack images by averaging ---
function stackImages(images: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
    const validImages = images.filter((img): img is Uint8ClampedArray => img !== null);
    if (validImages.length === 0) throw new Error("No valid images to stack");
    const length = validImages[0].length;
    const accum = new Float32Array(length);
    const counts = new Uint8Array(length / 4); // Count per pixel

    for (const img of validImages) {
        for (let i = 0; i < length; i += 4) {
            if (img[i + 3] > 128) { // Consider pixel valid if alpha is > 50%
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
            result[i] = Math.min(255, accum[i] / count);
            result[i + 1] = Math.min(255, accum[i + 1] / count);
            result[i + 2] = Math.min(255, accum[i + 2] / count);
            result[i + 3] = 255; // Final image is opaque
        }
    }
    return result;
}

// --- 13) Main alignment function ---
export async function alignAndStack(
  imageEntries: ImageQueueEntry[],
  manualRefStars: Star[],
  addLog: (message: string) => void,
  setProgress: (progress: number) => void
): Promise<Uint8ClampedArray> {
  if (imageEntries.length === 0 || !imageEntries[0].imageData) {
    throw new Error("No valid images provided.");
  }

  const MIN_STARS_FOR_ALIGNMENT = 10;
  const refEntry = imageEntries[0];
  const { width, height } = refEntry.imageData;
  let alignedImageDatas: (Uint8ClampedArray | null)[] = [refEntry.imageData.data];
  
  const allRefStars = manualRefStars.length > 0 ? manualRefStars : refEntry.detectedStars;
  if (allRefStars.length < 3) {
    addLog("Warning: Fewer than 3 reference stars. Alignment quality may be poor.");
  }
  
  const p1_refs: Point[] = [];
  const tempRefStars = [...allRefStars].sort((a,b) => b.brightness - a.brightness); 
  
  while (p1_refs.length < 3 && tempRefStars.length > 0) {
    const candidate = tempRefStars.shift()!;
    if (p1_refs.every(anchor => euclideanDist(anchor, candidate) > 50)) {
        p1_refs.push(candidate);
    }
  }

  if (p1_refs.length < 2) {
    addLog("Warning: Could not select at least 2 unique anchor stars. Alignment may fail.");
  }

  let last_known_points: (Point | null)[] = [...p1_refs];

  for (let i = 1; i < imageEntries.length; i++) {
    const targetEntry = imageEntries[i];
    if (!targetEntry.imageData) {
      addLog(`Skipping image ${i} due to missing image data.`);
      alignedImageDatas.push(null);
      setProgress(i / imageEntries.length);
      continue;
    }

    if (targetEntry.detectedStars.length < MIN_STARS_FOR_ALIGNMENT) {
      addLog(`Skipping image ${i}: Found only ${targetEntry.detectedStars.length} stars (min ${MIN_STARS_FOR_ALIGNMENT} required).`);
      alignedImageDatas.push(null);
      setProgress(i / imageEntries.length);
      continue;
    }
    
    let transform: { scale: number; rotation: number; translation: Point } | null = null;
    
    // --- Start: 3-point propagation logic ---
    const p1: Point[] = []; // Points from original reference image that are found in target
    const p2: Point[] = []; // Corresponding points found in target image
    
    const current_found_points: (Point | null)[] = [...last_known_points].map(() => null);

    for (let j = 0; j < p1_refs.length; j++) {
        const lastKnownPos = last_known_points[j];
        if (!lastKnownPos) continue;
        
        const SEARCH_RADIUS = 30;
        const candidates = targetEntry.detectedStars
            .filter(s => euclideanDist(s, lastKnownPos) < SEARCH_RADIUS)
            .sort((a,b) => euclideanDist(a, lastKnownPos) - euclideanDist(b, lastKnownPos));

        if(candidates.length > 0){
          const bestMatch = candidates[0]; // Simplest assumption: closest is best
          p1.push(p1_refs[j]);
          p2.push(bestMatch);
          current_found_points[j] = bestMatch;
        }
    }
    
    last_known_points = current_found_points;
    
    if (p1.length >= 2) { // Need at least 2 points for similarity transform
        transform = estimateSimilarityTransform(p1, p2);
        if (transform) {
            addLog(`Image ${i}: Aligned using ${p1.length}-point propagated pattern.`);
        }
    }
    // --- End: 3-point propagation logic ---

    // Fallback to RANSAC if propagation fails
    if (!transform) {
      addLog(`Image ${i}: Pattern propagation failed or had too few points. Falling back to feature matching.`);
      const matches = matchFeatures(allRefStars, targetEntry.detectedStars);
      if (matches.length >= 3) {
        const ransacPoints1 = matches.map(m => m[0]);
        const ransacPoints2 = matches.map(m => m[1]);
        transform = estimateSimilarityTransformRANSAC(ransacPoints1, ransacPoints2);
        if (transform) {
          addLog(`Image ${i}: Aligned using RANSAC fallback (${matches.length} initial matches).`);
        }
      }
    }
      
    if (transform) {
      const warpedData = warpImage(targetEntry.imageData.data, width, height, transform);
      alignedImageDatas.push(warpedData);
    } else {
      addLog(`Skipping image ${i}: Could not determine transform.`);
      alignedImageDatas.push(null); // Add null if transform fails
    }
    setProgress(i / imageEntries.length);
  }

  setProgress(1);
  addLog("All images aligned. Stacking...");
  return stackImages(alignedImageDatas);
}

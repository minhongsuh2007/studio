
// astro-align.ts

import * as math from "mathjs";

export type Point = { x: number; y: number };

// === 1. Estimate Affine Transform from 3+ matched star points ===

export function estimateAffineTransform(
  src: Point[],
  dst: Point[]
): number[][] {
  if (src.length !== dst.length || src.length < 3) {
    throw new Error("At least 3 matching points required for affine transform.");
  }

  const N = src.length;
  const A: number[][] = [];
  const B: number[] = [];

  for (let i = 0; i < N; i++) {
    const { x, y } = src[i];
    const { x: x2, y: y2 } = dst[i];

    A.push([x, y, 1, 0, 0, 0]);
    A.push([0, 0, 0, x, y, 1]);
    B.push(x2);
    B.push(y2);
  }

  const AT = math.transpose(A);
  const ATA = math.multiply(AT, A) as number[][];
  const ATB = math.multiply(AT, B) as number[];
  
  let x_solution: number[];
  try {
    const solutionMatrix = math.lusolve(ATA, ATB);
    
    if (math.isMatrix(solutionMatrix) && (solutionMatrix as math.Matrix).size().length === 2 && (solutionMatrix as math.Matrix).size()[1] === 1) {
        x_solution = (solutionMatrix as math.Matrix).toArray().map(v => v[0]) as number[];
    } else if (Array.isArray(solutionMatrix) && solutionMatrix.every(arr => Array.isArray(arr) && arr.length === 1)) {
        x_solution = solutionMatrix.map(v => v[0]) as number[];
    } else if (Array.isArray(solutionMatrix) && solutionMatrix.every(n => typeof n === 'number')) {
        // Handle if lusolve directly returns a flat array (e.g., for mathjs v11+)
        x_solution = solutionMatrix as number[];
    } else {
        console.error("Unexpected lusolve solution shape:", solutionMatrix);
        throw new Error("Could not solve for affine parameters due to unexpected matrix shape or content.");
    }
  } catch (e) {
    console.error("Error in LUSolve:", e);
    throw new Error(`Failed to solve linear system for affine transform: ${e instanceof Error ? e.message : String(e)}`);
  }
  

  if (x_solution.length !== 6) {
      throw new Error(`Affine transform estimation resulted in ${x_solution.length} parameters, expected 6.`);
  }

  // Check for non-finite parameters
  for (let i = 0; i < x_solution.length; i++) {
    if (!isFinite(x_solution[i])) {
      console.error("Non-finite parameter detected in x_solution:", x_solution);
      throw new Error(`Affine transform estimation resulted in non-finite parameters (e.g., NaN or Infinity at index ${i}: ${x_solution[i]}).`);
    }
  }

  return [
    [x_solution[0], x_solution[1], x_solution[2]], // for x' = ax + by + c
    [x_solution[3], x_solution[4], x_solution[5]], // for y' = dx + ey + f
  ];
}

// === 2. Apply Affine Transform to a Point or Array ===

export function transformPoint(p: Point, matrix: number[][]): Point {
  const [a, b, c] = matrix[0];
  const [d, e, f] = matrix[1];
  return {
    x: a * p.x + b * p.y + c,
    y: d * p.x + e * p.y + f,
  };
}

export function transformPoints(
  points: Point[],
  matrix: number[][]
): Point[] {
  return points.map((p) => transformPoint(p, matrix));
}

// === 3. Warp Canvas Image to Align to Reference ===

export function warpImage(
  srcCtx: CanvasRenderingContext2D,
  dstCtx: CanvasRenderingContext2D,
  matrix: number[][],
  addLog?: (message: string) => void
) {
  if (matrix.length !== 2 || matrix[0].length !== 3 || matrix[1].length !== 3) {
    if(addLog) addLog(`[WARP ERROR] Invalid matrix format for warpImage. Matrix: ${JSON.stringify(matrix)}. Drawing original.`);
    dstCtx.drawImage(srcCtx.canvas, 0, 0); 
    return;
  }
  const [a, b, c] = matrix[0];
  const [d, e, f] = matrix[1];

  // Final check for non-finite values in the matrix passed to warp
  if (![a,b,c,d,e,f].every(isFinite)) {
    if(addLog) addLog(`[WARP ERROR] Non-finite values in affine matrix before setTransform: a=${a},b=${b},c=${c},d=${d},e=${e},f=${f}. Drawing original.`);
    dstCtx.drawImage(srcCtx.canvas, 0, 0);
    return;
  }

  if (addLog) {
    addLog(`[WARP] Applying matrix: a=${a.toFixed(4)}, b=${b.toFixed(4)}, c=${c.toFixed(2)}, d=${d.toFixed(4)}, e=${e.toFixed(4)}, f=${f.toFixed(2)}`);
  }

  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = 'high';
  
  dstCtx.save(); // Save current state
  dstCtx.setTransform(a, d, b, e, c, f);
  dstCtx.drawImage(srcCtx.canvas, 0, 0);
  dstCtx.restore(); // Restore original transform (important!)
}



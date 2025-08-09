
'use client';

// Function to create a master calibration frame (dark, bias, or flat) by averaging
export async function createMasterFrame(
    frames: (ImageData | null)[],
    mode: 'average' = 'average', // For now, only average is supported
    addLog: (message: string) => void,
    frameType: 'DARK' | 'FLAT' | 'BIAS'
): Promise<ImageData | null> {
    const validFrames = frames.filter((f): f is ImageData => f !== null);
    if (validFrames.length === 0) {
        addLog(`[MASTER ${frameType}] Creation failed: No valid frames provided.`);
        return null;
    }

    addLog(`[MASTER ${frameType}] Creating master frame from ${validFrames.length} source frames.`);
    const { width, height } = validFrames[0];

    // Check if all frames have the same dimensions
    if (validFrames.some(f => f.width !== width || f.height !== height)) {
        addLog(`[ERROR] ${frameType} frames have mismatched dimensions. Cannot create master.`);
        // For simplicity, we'll just use the first frame if dimensions mismatch
        // A more robust solution might be to resize or throw a more significant error
        return validFrames[0];
    }
    
    const pixelCount = width * height * 4;
    const masterData = new Float32Array(pixelCount);

    for (const frame of validFrames) {
        for (let i = 0; i < pixelCount; i++) {
            masterData[i] += frame.data[i];
        }
    }

    const averagedData = new Uint8ClampedArray(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        averagedData[i] = masterData[i] / validFrames.length;
    }
    
    addLog(`[MASTER ${frameType}] Master frame created successfully (${width}x${height}).`);
    return new ImageData(averagedData, width, height);
}

// Function to subtract one image from another
function subtract(source: ImageData, toSubtract: ImageData): ImageData {
    const { width, height, data: sourceData } = source;
    const { data: subtractData } = toSubtract;
    const resultData = new Uint8ClampedArray(sourceData.length);

    // Basic dimension check
    if (source.width !== toSubtract.width || source.height !== toSubtract.height) {
        console.warn("Dimension mismatch during subtraction. This may produce artifacts.");
        // A more robust implementation might scale the 'toSubtract' image.
        // For now, we proceed, which might lead to incorrect results if sizes differ.
    }
    
    for (let i = 0; i < sourceData.length; i += 4) {
        resultData[i] = Math.max(0, sourceData[i] - subtractData[i]);
        resultData[i + 1] = Math.max(0, sourceData[i + 1] - subtractData[i + 1]);
        resultData[i + 2] = Math.max(0, sourceData[i + 2] - subtractData[i + 2]);
        resultData[i + 3] = sourceData[i + 3]; // Preserve alpha
    }

    return new ImageData(resultData, width, height);
}

// Function to divide one image by another (for flat fielding)
function divide(source: ImageData, flat: ImageData): ImageData {
    const { width, height, data: sourceData } = source;
    const { data: flatData } = flat;
    const resultData = new Uint8ClampedArray(sourceData.length);

    if (source.width !== flat.width || source.height !== flat.height) {
        console.warn("Dimension mismatch during flat division. This may produce artifacts.");
    }
    
    // First, find the average brightness of the master flat to normalize it
    let flatAvg = 0;
    for(let i = 0; i < flatData.length; i+=4) {
        flatAvg += (flatData[i] + flatData[i+1] + flatData[i+2]) / 3;
    }
    flatAvg /= (flatData.length / 4);

    if (flatAvg === 0) {
        console.error("Master flat average is 0, cannot divide. Skipping flat correction.");
        return source;
    }

    for (let i = 0; i < sourceData.length; i += 4) {
        const flatR = flatData[i] / flatAvg;
        const flatG = flatData[i+1] / flatAvg;
        const flatB = flatData[i+2] / flatAvg;
        
        // Prevent division by zero or near-zero
        resultData[i] = flatR > 0.1 ? Math.min(255, sourceData[i] / flatR) : sourceData[i];
        resultData[i+1] = flatG > 0.1 ? Math.min(255, sourceData[i+1] / flatG) : sourceData[i+1];
        resultData[i+2] = flatB > 0.1 ? Math.min(255, sourceData[i+2] / flatB) : sourceData[i+2];
        resultData[i+3] = sourceData[i + 3];
    }
    
    return new ImageData(resultData, width, height);
}


// Main function to apply all selected calibrations to a light frame
export function applyCalibration(
    lightFrame: ImageData,
    masterDark: ImageData | null,
    masterBias: ImageData | null,
    masterFlat: ImageData | null,
    addLog: (message: string) => void,
    lightFrameName: string
): ImageData {
    let calibratedFrame = lightFrame;
    
    // Bias subtraction is usually done first (or from darks/flats)
    if (masterBias) {
        addLog(`[CALIBRATE] Subtracting Master Bias from ${lightFrameName}...`);
        calibratedFrame = subtract(calibratedFrame, masterBias);
    }
    
    // Then Dark subtraction
    if (masterDark) {
        addLog(`[CALIBRATE] Subtracting Master Dark from ${lightFrameName}...`);
        calibratedFrame = subtract(calibratedFrame, masterDark);
    }

    // Finally, Flat division
    if (masterFlat) {
        addLog(`[CALIBRATE] Applying Master Flat to ${lightFrameName}...`);
        calibratedFrame = divide(calibratedFrame, masterFlat);
    }

    return calibratedFrame;
}

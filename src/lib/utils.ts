import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import TIFF from 'tiff.js';


export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const fileToArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = error => reject(error);
      reader.readAsArrayBuffer(file);
  });
};

const convertTypedArrayToImageData = (
  data: Uint8Array | Uint16Array | Uint32Array,
  width: number,
  height: number,
  isGrayscale: boolean
): ImageData => {
  const imageData = new ImageData(width, height);
  const outputData = imageData.data;
  
  // Find min/max for normalization
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > max) max = data[i];
    if (data[i] < min) min = data[i];
  }
  const range = max - min;
  if (range === 0) { // Avoid division by zero for flat images
    const fillValue = min > 255 ? 255 : min;
    for (let i = 0; i < outputData.length; i += 4) {
      outputData[i] = fillValue;
      outputData[i + 1] = fillValue;
      outputData[i + 2] = fillValue;
      outputData[i + 3] = 255;
    }
    return imageData;
  }

  const scale = 255 / range;

  if (isGrayscale) {
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
          const val = (data[i] - min) * scale;
          outputData[j] = val;
          outputData[j + 1] = val;
          outputData[j + 2] = val;
          outputData[j + 3] = 255;
      }
  } else { // Basic RGB handling
      const pixels = data.length / 3;
      for (let i = 0; i < pixels; i++) {
          const r = (data[i * 3] - min) * scale;
          const g = (data[i * 3 + 1] - min) * scale;
          const b = (data[i * 3 + 2] - min) * scale;
          outputData[i * 4] = r;
          outputData[i * 4 + 1] = g;
          outputData[i * 4 + 2] = b;
          outputData[i * 4 + 3] = 255;
      }
  }
  return imageData;
};

const renderImageDataToDataURL = (imageData: ImageData): string => {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Could not create canvas context for rendering.");
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
};


export const fileToDataURL = async (file: File): Promise<string> => {
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith('.tif') || fileName.endsWith('.tiff') || fileName.endsWith('.dng')) {
    try {
        const buffer = await fileToArrayBuffer(file);
        const tiff = new TIFF({ buffer });
        const width = tiff.width();
        const height = tiff.height();
        const rgba = tiff.readRGBAImage(); // returns Uint8Array
        const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer), width, height);
        return renderImageDataToDataURL(imageData);
    } catch (error) {
        console.error("Error processing TIFF/DNG file:", error);
        throw new Error("Failed to parse TIFF/DNG file.");
    }
  }

  // FITS support removed due to package issues
  if (fileName.endsWith('.fit') || fileName.endsWith('.fits')) {
    return Promise.reject(new Error("FITS file support is temporarily unavailable due to issues with the 'fitsjs' library. Please use another format."));
  }

  // Fallback for standard browser-supported images (JPG, PNG, WEBP, etc.)
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
    reader.readAsDataURL(file);
  });
};


import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { call } from 'wasm-imagemagick';

declare const window: any;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const processWithFileReader = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        resolve(e.target.result as string);
      } else {
        reject(new Error("FileReader failed for standard image format."));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

const processFileWithImageMagick = async (file: File): Promise<string> => {
  try {
    const buffer = await file.arrayBuffer();
    const inputFiles = [{ name: file.name, content: new Uint8Array(buffer) }];
    const outputName = 'output.png';

    // Use [0] to ensure only the first frame of a multi-frame file (like GIF or some TIFFs) is processed
    const command = ['convert', `${file.name}[0]`, outputName];
    
    const result = await call(inputFiles, command);
    const outputFile = result.find(f => f.name === outputName);

    if (!outputFile) {
        throw new Error(`ImageMagick conversion failed to produce ${outputName}.`);
    }

    const blob = new Blob([outputFile.content], { type: 'image/png' });

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target?.result as string);
        reader.onerror = e => reject(e);
        reader.readAsDataURL(blob);
    });

  } catch (error) {
    console.error("Error processing file with ImageMagick:", error);
    // Fallback for standard types if Magick fails for some reason
    if (['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) {
      return processWithFileReader(file);
    }
    throw new Error(`Failed to process file ${file.name} with ImageMagick.`);
  }
};

export const fileToDataURL = (file: File): Promise<string> => {
  const isStandardWebFormat = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type);

  // Use the standard FileReader for common web formats as it's faster
  if (isStandardWebFormat) {
    return processWithFileReader(file);
  }

  // For non-standard formats (FITS, TIFF, RAW, etc.), use ImageMagick
  // No need to check for `window.ImageMagick` as the `call` function from the wasm-imagemagick library handles it.
  return processFileWithImageMagick(file);
};


import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

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
    const Module = window.ImageMagick;
    
    try {
        const buffer = await file.arrayBuffer();
        const name = file.name;
        const inPath = '/' + name;
        const outPath = '/output.png'; // Use PNG to preserve quality and transparency

        try { Module.FS_unlink(inPath); } catch (e) {}
        Module.FS_createDataFile('/', name, new Uint8Array(buffer), true, true);
        
        // Use [0] to ensure only the first frame of a multi-frame file (like GIF) is processed
        const args = ['convert', `${inPath}[0]`, outPath];
        Module.callMain(args);
        
        const outData = Module.FS_readFile(outPath);
        const blob = new Blob([outData], { type: 'image/png' }); // Output as PNG
        
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
}


export const fileToDataURL = (file: File): Promise<string> => {
  const isStandardWebFormat = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type);

  // Use the standard FileReader for common web formats as it's faster
  if (isStandardWebFormat) {
    return processWithFileReader(file);
  }

  // For non-standard formats (FITS, TIFF, RAW, etc.), use ImageMagick
  return new Promise((resolve, reject) => {
    // If ImageMagick is already loaded, use it immediately.
    if (window.ImageMagick) {
      processFileWithImageMagick(file).then(resolve).catch(reject);
    } else {
      // Otherwise, wait for the wasmReady event. This is crucial for the first time a non-standard file is loaded.
      const handleWasmReady = () => {
        processFileWithImageMagick(file).then(resolve).catch(reject);
      };
      document.addEventListener('wasmReady', handleWasmReady, { once: true });
    }
  });
};

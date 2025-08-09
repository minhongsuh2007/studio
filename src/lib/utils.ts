
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

declare const window: any;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const fileToDataURL = async (file: File): Promise<string> => {
  // Check if ImageMagick is ready, but only if it's needed for the file type
  const isStandardWebFormat = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type);

  if (isStandardWebFormat) {
    // Use the fast, native FileReader for standard formats
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
  }

  // For non-standard formats, wait for and use ImageMagick
  if (!window.ImageMagick) {
    return new Promise((resolve) => {
      // Wait for the custom event that signals WASM is ready
      document.addEventListener('wasmReady', () => {
        resolve(processFileWithImageMagick(file));
      }, { once: true });
    });
  }
  
  return processFileWithImageMagick(file);
};


async function processFileWithImageMagick(file: File): Promise<string> {
    const Module = window.ImageMagick;
    
    try {
        const buffer = await file.arrayBuffer();
        const name = file.name;
        const inPath = '/' + name;
        const outPath = '/output.png';

        // Write the file to the virtual FS
        try { Module.FS_unlink(inPath); } catch (e) {}
        Module.FS_createDataFile('/', name, new Uint8Array(buffer), true, true);
        
        // Execute the command: convert input.ext output.png
        const args = ['convert', inPath, outPath];
        Module.callMain(args);
        
        // Read the result
        const outData = Module.FS_readFile(outPath);
        const blob = new Blob([outData], { type: 'image/png' });
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target?.result as string);
            reader.onerror = e => reject(e);
            reader.readAsDataURL(blob);
        });

    } catch (error) {
        console.error("Error processing file with ImageMagick:", error);
        // Fallback to simple FileReader for basic types if Magick fails (as a safety net)
        if (['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (e.target?.result) {
                        resolve(e.target.result as string);
                    } else {
                        reject(new Error("Fallback FileReader failed."));
                    }
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }
        throw new Error(`Failed to process file ${file.name} with ImageMagick.`);
    }
}

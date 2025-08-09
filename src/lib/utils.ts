
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { ImageMagick, MagickFormat, initializeImageMagick } from '@imagemagick/magick-wasm';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}


// Initialize ImageMagick on module load. This is a crucial step.
// The library needs to fetch its WASM file, so we provide the URL.
const wasmUrl = new URL(
  '@imagemagick/magick-wasm/magick.wasm',
  import.meta.url
).href;

initializeImageMagick(wasmUrl).catch(err => {
  console.error("Failed to initialize ImageMagick", err);
});


export const fileToDataURL = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        if (!e.target?.result) {
          return reject(new Error("FileReader failed to read the file."));
        }
        
        const arrayBuffer = e.target.result as ArrayBuffer;
        const inputBytes = new Uint8Array(arrayBuffer);

        // Use ImageMagick to read ANY supported file format and convert it to a standard PNG Data URL.
        // This is where the magic happens. ImageMagick handles the complexity of different formats.
        ImageMagick.read(inputBytes, (image) => {
          // We convert to PNG for consistency within the application's processing pipeline.
          image.write(MagickFormat.Png, (outputBytes) => {
            const blob = new Blob([outputBytes], { type: 'image/png' });
            const dataUrlReader = new FileReader();
            dataUrlReader.onload = (event) => {
              if (event.target?.result) {
                resolve(event.target.result as string);
              } else {
                reject(new Error("Failed to read converted image blob to data URL."));
              }
            };
            dataUrlReader.onerror = (error) => {
              reject(new Error("Failed to read converted image blob to data URL: " + error));
            };
            dataUrlReader.readAsDataURL(blob);
          });
        });
      } catch (error) {
        console.error("ImageMagick processing error:", error);
        reject(new Error("Failed to process image with ImageMagick. The file may be corrupt or an unsupported format."));
      }
    };
    reader.onerror = (error) => {
      reject(new Error("FileReader error: " + error));
    };
    reader.readAsArrayBuffer(file);
  });
};

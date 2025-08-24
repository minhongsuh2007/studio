
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const processWithFileReader = (file: File): Promise<string> => {
  console.log(`[FileReader] Processing standard web format for: ${file.name}`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        console.log(`[FileReader] Successfully read ${file.name}`);
        resolve(e.target.result as string);
      } else {
        console.error(`[FileReader] Failed to read file, event target result is null for ${file.name}.`);
        reject(new Error(`FileReader failed for ${file.name}.`));
      }
    };
    reader.onerror = (e) => {
        console.error(`[FileReader] Error reading file ${file.name}:`, e);
        reject(new Error(`Error reading file ${file.name}.`))
    };
    reader.readAsDataURL(file);
  });
};

const processFileWithImageMagick = async (file: File): Promise<string> => {
  console.log(`[ImageMagick] Starting conversion process for: ${file.name}`);
  try {
    const { call } = await import('wasm-imagemagick');
    
    const buffer = await file.arrayBuffer();
    const inputFiles = [{ name: file.name, content: new Uint8Array(buffer) }];
    const outputName = 'output.png';

    const command = ['convert', `${file.name}[0]`, outputName];
    console.log(`[ImageMagick] Executing command:`, command.join(' '));
    
    const result = await call(inputFiles, command);
    const outputFile = result.find(f => f.name === outputName);

    if (!outputFile) {
        throw new Error(`ImageMagick conversion did not produce the expected output file: ${outputName}.`);
    }
    console.log(`[ImageMagick] Successfully converted ${file.name} to ${outputName}. Size: ${outputFile.content.byteLength} bytes.`);

    const blob = new Blob([outputFile.content], { type: 'image/png' });
    console.log(`[ImageMagick] Created Blob from output file.`);

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            console.log(`[ImageMagick] Successfully converted Blob to Data URL for ${file.name}.`);
            resolve(e.target?.result as string);
        }
        reader.onerror = e => {
            console.error(`[ImageMagick] FileReader error after conversion for ${file.name}:`, e);
            reject(e);
        }
        reader.readAsDataURL(blob);
    });

  } catch (error) {
    console.error(`[ImageMagick] CRITICAL ERROR during conversion of ${file.name}:`, error);
    // Fallback for standard types if Magick fails for some reason
    if (['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) {
      console.warn(`[ImageMagick] Fallback to FileReader for ${file.name}.`);
      return processWithFileReader(file);
    }
    throw new Error(`Failed to process file ${file.name} with ImageMagick. Reason: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
};

export const fileToDataURL = async (file: File): Promise<string> => {
  const isStandardWebFormat = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type);

  if (isStandardWebFormat) {
    console.log(`[fileToDataURL] Using standard FileReader for ${file.name} (type: ${file.type})`);
    return processWithFileReader(file);
  }

  console.log(`[fileToDataURL] Using ImageMagick for ${file.name} (type: ${file.type})`);
  return processFileWithImageMagick(file);
};

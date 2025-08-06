import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const fileToDataURL = async (file: File): Promise<string> => {
  const fileName = file.name.toLowerCase();

  // FITS/TIFF support removed due to package issues
  if (fileName.endsWith('.fit') || fileName.endsWith('.fits') || fileName.endsWith('.tif') || fileName.endsWith('.tiff') || fileName.endsWith('.dng')) {
    return Promise.reject(new Error("RAW file support (FITS, TIFF, DNG) is temporarily unavailable due to issues with third-party libraries. Please use a standard format like PNG or JPG."));
  }

  // Fallback for standard browser-supported images (JPG, PNG, WEBP, etc.)
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
    reader.readAsDataURL(file);
  });
};

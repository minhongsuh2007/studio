
import type { Star as BaseStar } from '@/lib/astro-align';

// Basic structure for an image in the processing queue
export interface ImageQueueEntry {
  id: string;
  file: File;
  originalPreviewUrl: string;
  analysisPreviewUrl: string;
  isAnalyzing: boolean;
  isAnalyzed: boolean;
  originalDimensions: { width: number; height: number };
  analysisDimensions: { width: number; height: number };
  imageData: ImageData | null;
  detectedStars: BaseStar[];
  manualStars: LabeledStar[];
}

// Structure for calibration frames (Darks, Flats, Bias)
export interface CalibrationFrameEntry {
  id: string;
  file: File;
  previewUrl: string;
  imageData: ImageData | null;
  dimensions: { width: number; height: number };
}

export type Star = BaseStar;

// Extends the base Star type to include a category ID for classification
export interface LabeledStar extends BaseStar {
  categoryId: string;
}

// A star that has been identified during a test run, includes color for visualization
export interface TestResultStar extends LabeledStar {
  color: string;
}

// Defines a user-created category for classifying stars
export interface StarCategory {
  id: string; // e.g., 'category-1'
  name: string; // e.g., 'Bright Core Stars'
  color: string; // e.g., '#FF6B6B'
}

// Represents the raw data extracted from a star for AI learning
export interface StarCharacteristics {
  avgBrightness: number;
  avgContrast: number;
  fwhm: number;
  pixelCount: number;
  centerRGB: [number, number, number];
  patch3x3RGB: [number, number, number];
  patch5x5RGB: [number, number, number];
}

// A collection of learned characteristics for a specific star category, from a specific image
export interface LearnedPattern {
  id: string; // Unique ID, e.g., `${imageFileName}::${categoryId}`
  sourceImageFileName: string;
  categoryId: string;
  timestamp: number;
  characteristics: StarCharacteristics[];
}

// --- Post-Processing Types ---
export interface Point {
  x: number;
  y: number;
}

export type Channel = 'rgb';

export interface Curve {
  rgb: Point[];
}

export interface PostProcessSettings {
  basic: {
    brightness: number;
    exposure: number;
    saturation: number;
  };
  curves: Curve;
}


// --- Enums for UI state ---

export type PreviewFitMode = 'contain' | 'cover';
export type OutputFormat = 'png' | 'jpeg';
export type AlignmentMethod = 'standard' | 'consensus' | 'planetary' | 'dumb';
export type StackingQuality = 'standard' | 'high';
export type StarDetectionMethod = 'general' | 'ai' | 'advanced';

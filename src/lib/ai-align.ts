
'use server';

import type { StackingMode, Transform } from '@/lib/astro-align';
import { findMatchingStars, type LearnedPattern, type SimpleImageData } from '@/lib/ai-star-matcher';
import type { Star } from '@/lib/astro-align';

// This file is now deprecated and will not be used for client-side AI stacking.
// The logic has been moved to ai-client-stack.ts to run in the browser.
// This file is kept to avoid breaking imports in case it's referenced elsewhere,
// but its core functionality is no longer invoked from the main page.

export interface SerializableImageQueueEntry {
  id: string;
  fileName: string;
  imageData: SimpleImageData | null,
  detectedStars: Star[];
  analysisDimensions: { width: number; height: number; };
};

export async function aiAlignAndStack(
  imageEntries: SerializableImageQueueEntry[],
  learnedPatterns: LearnedPattern[],
  mode: StackingMode
): Promise<{stackedImageData: number[] | null, logs: string[]}> {
  const logs: string[] = ["[DEPRECATED] aiAlignAndStack is no longer the primary method. Please use client-side AI stacking."];
  console.warn("aiAlignAndStack (server-side) was called, but this functionality has been moved to the client. Please update the caller.");
  
  // Return a dummy response to avoid breaking callers that haven't been updated.
  return { stackedImageData: null, logs };
}

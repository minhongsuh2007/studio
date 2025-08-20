
'use client';

// This file is obsolete as of the new client-side-only implementation.
// All logic has been moved to src/lib/client-side-identifier.ts
// This file can be safely deleted. It is kept temporarily to avoid breaking imports
// during the transition, but it is no longer used.

export interface CelestialIdentificationResult {
  summary: string;
  constellations: string[];
  objects_in_field: string[];
  targetFound: boolean;
}

export async function identifyCelestialObjects(
  imageDataUri: string
): Promise<CelestialIdentificationResult> {
  console.warn(
    'DEPRECATED: The server-side `identifyCelestialObjects` function was called, but this logic has been moved to the client. Please use `identifyCelestialObjectsFromImage` from `src/lib/client-side-identifier.ts` instead.'
  );

  // Return a dummy response to ensure callers don't crash.
  return {
    summary: 'This function is deprecated. Analysis was not performed.',
    constellations: [],
    objects_in_field: [],
    targetFound: false,
  };
}

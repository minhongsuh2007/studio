'use server';
/**
 * @fileOverview A flow for identifying celestial objects by calling the astrometry.net API.
 *
 * - identifyCelestialObjects: Analyzes an image to find constellations and other objects.
 * - CelestialIdentificationInput: The input type for the flow.
 * - CelestialIdentificationResult: The return type for the flow.
 */

import { AstrometryNet } from '@/lib/astrometry.net';

export interface CelestialIdentificationInput {
  imageDataUri: string;
  log: (message: string) => void;
}

export interface CelestialIdentificationResult {
  summary: string;
  constellations: string[];
  objects_in_field: string[];
}

// Define the exported wrapper function that calls the astrometry.net API
export async function identifyCelestialObjects(input: CelestialIdentificationInput): Promise<CelestialIdentificationResult> {
  const apiKey = process.env.ASTROMETRY_API_KEY;
  if (!apiKey) {
    throw new Error('Astrometry.net API key is not configured. Please set ASTROMETRY_API_KEY in your environment variables.');
  }

  input.log('[ASTROMETRY] Initializing API client...');
  const astro = new AstrometryNet(apiKey);

  input.log('[ASTROMETRY] Logging in to get session key...');
  await astro.login();
  input.log('[ASTROMETRY] Login successful. Uploading image...');

  // Convert data URI to a Blob for upload
  const fetchResponse = await fetch(input.imageDataUri);
  const blob = await fetchResponse.blob();

  const subId = await astro.upload(blob);
  input.log(`[ASTROMETRY] Image uploaded successfully. Submission ID: ${subId}`);

  let jobResult;
  while (true) {
    const status = await astro.getJobStatus(subId);
    input.log(`[ASTROMETRY] Job status: ${status.status}`);
    if (status.status === 'success') {
      jobResult = status;
      break;
    } else if (status.status === 'failure') {
      throw new Error('Astrometry.net job failed.');
    }
    // Wait for 10 seconds before polling again
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  if (!jobResult || !jobResult.job) {
     throw new Error('Astrometry.net job finished but no result was returned.');
  }

  input.log(`[ASTROMETRY] Job ${jobResult.job} complete. Fetching annotations...`);
  const annotations = await astro.getAnnotations(jobResult.job);
  
  const constellations = [...new Set(annotations.annotations.map(a => a.names[0]).filter(name => name.includes("Constellation")))].map(c => c.replace("Constellation", "").trim());
  const objectsInField = annotations.annotations.map(a => a.names[0]).filter(name => !name.includes("Constellation"));

  return {
    summary: `Analysis complete. Found ${constellations.length} constellation(s) and ${objectsInField.length} other object(s).`,
    constellations: constellations,
    objects_in_field: objectsInField,
  };
}

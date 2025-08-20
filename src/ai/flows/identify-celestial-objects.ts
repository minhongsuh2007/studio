
'use server';
/**
 * @fileOverview A flow for identifying celestial objects by calling the astrometry.net API.
 *
 * - identifyCelestialObjects: Analyzes an image to find constellations and other objects.
 * - CelestialIdentificationInput: The input type for the flow.
 * - CelestialIdentificationResult: The return type for the flow.
 */

export interface CelestialIdentificationInput {
  imageDataUri: string;
  celestialObject?: string; // Optional: The celestial object the user wants to find
}

export interface CelestialIdentificationResult {
  summary: string;
  constellations: string[];
  objects_in_field: string[];
  targetFound: boolean;
}

const API_URL = 'https://nova.astrometry.net/api';

// Helper function to perform requests to the Astrometry.net API
async function requestAstrometry(endpoint: string, body: any, isUpload: boolean = false) {
  const url = `${API_URL}/${endpoint}`;
  const options: RequestInit = {
    method: 'POST',
    ...(isUpload ? { body } : { body: `request-json=${encodeURIComponent(JSON.stringify(body))}` }),
    ...(!isUpload && { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
  };

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Astrometry.net API error on ${endpoint}: ${response.status} ${response.statusText} - ${errorText}`);
  }
  return response.json();
}


// Define the exported wrapper function that calls the astrometry.net API
export async function identifyCelestialObjects(input: CelestialIdentificationInput): Promise<CelestialIdentificationResult> {
  const apiKeysString = process.env.ASTROMETRY_API_KEYS;
  if (!apiKeysString) {
    throw new Error('Astrometry.net API keys are not configured. Please set ASTROMETRY_API_KEYS in your environment variables.');
  }
  
  const apiKeys = apiKeysString.split(',').map(key => key.trim()).filter(key => key);
  if (apiKeys.length === 0) {
      throw new Error('No valid Astrometry.net API keys found in the configuration.');
  }

  // Select a random API key from the list
  const apiKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];

  const loginData = await requestAstrometry('login', { apikey: apiKey });
  if (loginData.status !== 'success') {
      throw new Error(`Astrometry.net login failed: ${loginData.errormessage}`);
  }
  const sessionKey = loginData.session;
  
  // Convert data URI to a Blob for upload
  const fetchResponse = await fetch(input.imageDataUri);
  const blob = await fetchResponse.blob();

  const formData = new FormData();
  formData.append('request-json', JSON.stringify({
       session: sessionKey,
       allow_commercial_use: 'd',
       allow_modifications: 'd',
       publicly_visible: 'y',
  }));
  formData.append('file', blob, 'image.png');

  const uploadData = await requestAstrometry('uploads', formData, true);
  if (uploadData.status !== 'success') {
       throw new Error(`Astrometry.net upload failed: ${uploadData.errormessage}`);
  }
  const subId = uploadData.subid;

  let jobResult;
  let jobId = null;

  while (true) {
    const subStatus = await fetch(`${API_URL}/submissions/${subId}`).then(res => res.json());
    if (subStatus.job_calibrations && subStatus.job_calibrations.length > 0 && subStatus.job_calibrations[0] !== null) {
        jobId = subStatus.job_calibrations[0][1];
        if (jobId) {
             break;
        }
    } else if (subStatus.error_message) {
        throw new Error(`Astrometry submission error: ${subStatus.error_message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  while (true) {
    const jobStatus = await fetch(`${API_URL}/jobs/${jobId}`).then(res => res.json());
    if (jobStatus.status === 'success') {
      jobResult = jobStatus;
      break;
    } else if (jobStatus.status === 'failure') {
      throw new Error('Astrometry.net job failed.');
    }
    // Wait for 10 seconds before polling again
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  if (!jobResult) {
     throw new Error('Astrometry.net job finished but no result was returned.');
  }

  const annotations = await fetch(`${API_URL}/jobs/${jobId}/annotations/`).then(res => res.json());
  
  const constellations = [...new Set(annotations.annotations.map((a: any) => a.names[0]).filter((name: string) => name.includes("Constellation")))].map((c: string) => c.replace("Constellation", "").trim());
  const objectsInField = annotations.annotations.map((a: any) => a.names[0]).filter((name: string) => !name.includes("Constellation"));
  
  let targetFound = false;
  if(input.celestialObject) {
      const searchTarget = input.celestialObject.toLowerCase();
      targetFound = objectsInField.some((obj: string) => obj.toLowerCase().includes(searchTarget));
  }

  const summary = `Analysis complete. Found ${constellations.length} constellation(s) and ${objectsInField.length} other object(s).`;
  
  return {
    summary,
    constellations,
    objects_in_field: objectsInField,
    targetFound,
  };
}

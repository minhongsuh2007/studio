
'use server';
/**
 * @fileOverview A flow for identifying celestial objects in an image.
 *
 * - identifyCelestialObjects: Analyzes an image to find constellations and a target object.
 * - CelestialIdentificationInput: The input type for the flow.
 * - CelestialIdentificationResult: The return type for the flow.
 */

import { ai } from '@/ai/genkit';
import { z } from 'zod';

const CelestialIdentificationInputSchema = z.object({
  imageDataUri: z
    .string()
    .describe(
      "A stacked astrophotography image as a data URI, including a MIME type and Base64 encoding. Format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  targetObjectName: z.string().optional().describe('An optional specific celestial object name to look for (e.g., "Andromeda Galaxy", "M42").'),
});
export type CelestialIdentificationInput = z.infer<typeof CelestialIdentificationInputSchema>;

const CelestialIdentificationResultSchema = z.object({
  summary: z.string().describe('A one-sentence summary of the identification results.'),
  constellations: z.array(z.string()).describe('A list of constellations identified in the image.'),
  targetInImage: z.boolean().describe('Whether the specified target object was found in the image.'),
  reasoning: z.string().describe('A brief explanation of how the conclusion was reached, mentioning key stars or patterns.'),
});
export type CelestialIdentificationResult = z.infer<typeof CelestialIdentificationResultSchema>;

// Define the exported wrapper function that calls the flow
export async function identifyCelestialObjects(input: CelestialIdentificationInput): Promise<CelestialIdentificationResult> {
  return identifyCelestialObjectsFlow(input);
}

// Define the prompt for the AI model
const identificationPrompt = ai.definePrompt({
  name: 'celestialIdentificationPrompt',
  input: { schema: CelestialIdentificationInputSchema },
  output: { schema: CelestialIdentificationResultSchema },
  prompt: `You are an expert astronomer with access to the entire celestial sphere database.
You will be given an image of the night sky. Your task is to perform astrometry (plate-solving) on this image.
Analyze the star patterns in the provided image to identify the exact region of the sky it represents.

Based on your analysis, provide the following:
1.  A list of the main constellations visible or partially visible in the frame.
2.  {{#if targetObjectName}}
    Determine if the celestial object "{{targetObjectName}}" is present in the image. Your conclusion must be definitive (true or false).
    {{else}}
    If no target object is specified, set the 'targetInImage' field to false.
    {{/if}}
3.  Provide a brief reasoning for your findings, mentioning any key stars or asterisms used for identification.
4.  Formulate a clear, one-sentence summary of your findings.

Image to analyze:
{{media url=imageDataUri}}`,
});

// Define the main flow
const identifyCelestialObjectsFlow = ai.defineFlow(
  {
    name: 'identifyCelestialObjectsFlow',
    inputSchema: CelestialIdentificationInputSchema,
    outputSchema: CelestialIdentificationResultSchema,
  },
  async (input) => {
    // Call the prompt with the input and wait for the structured output
    const { output } = await identificationPrompt(input);

    if (!output) {
      throw new Error('The AI model failed to return a valid identification.');
    }
    
    // The prompt handler now returns the structured object directly
    return output;
  }
);

// Adjust stacking parameters based on user preferences.
'use server';

/**
 * @fileOverview Adjust stacking parameters for astrophotography images.
 *
 * - adjustStackingParameters - A function that handles the adjustment of stacking parameters.
 * - AdjustStackingParametersInput - The input type for the adjustStackingParameters function.
 * - AdjustStackingParametersOutput - The return type for the adjustStackingParameters function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const AdjustStackingParametersInputSchema = z.object({
  baseImageDataUri: z
    .string()
    .describe(
      "The base stacked image to adjust, as a data URI that must include a MIME type and use Base64 encoding. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
  alignmentMethod: z
    .enum(['auto', 'star_alignment', 'manual'])
    .describe('The method used to align the images during stacking.'),
  stackingMode: z
    .enum(['average', 'lighten', 'darken'])
    .describe('The mode used to combine the images during stacking.'),
});
export type AdjustStackingParametersInput = z.infer<typeof AdjustStackingParametersInputSchema>;

const AdjustStackingParametersOutputSchema = z.object({
  adjustedImageDataUri: z
    .string()
    .describe(
      "The adjusted stacked image, as a data URI that must include a MIME type and use Base64 encoding. Expected format: 'data:<mimetype>;base64,<encoded_data>'."
    ),
});
export type AdjustStackingParametersOutput = z.infer<typeof AdjustStackingParametersOutputSchema>;

export async function adjustStackingParameters(
  input: AdjustStackingParametersInput
): Promise<AdjustStackingParametersOutput> {
  return adjustStackingParametersFlow(input);
}

const prompt = ai.definePrompt({
  name: 'adjustStackingParametersPrompt',
  input: {schema: AdjustStackingParametersInputSchema},
  output: {schema: AdjustStackingParametersOutputSchema},
  prompt: `You are an expert astrophotographer specializing in image stacking.

You will adjust the stacking parameters of the provided base image to reduce noise and enhance details.

Alignment Method: {{{alignmentMethod}}}
Stacking Mode: {{{stackingMode}}}

Base Image: {{media url=baseImageDataUri}}

Generate the adjusted stacked image using the given parameters. Ensure the output is a data URI.
`,
});

const adjustStackingParametersFlow = ai.defineFlow(
  {
    name: 'adjustStackingParametersFlow',
    inputSchema: AdjustStackingParametersInputSchema,
    outputSchema: AdjustStackingParametersOutputSchema,
  },
  async input => {
    const {media} = await ai.generate({
      prompt: [
        {media: {url: input.baseImageDataUri}},
        {
          text: `Adjust stacking parameters with alignment method: ${input.alignmentMethod}, stacking mode: ${input.stackingMode}.`,
        },
      ],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    return {adjustedImageDataUri: media.url!};
  }
);

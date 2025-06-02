'use server';
/**
 * @fileOverview An AI agent that stacks astrophotography images based on a prompt.
 *
 * - initialStackFromPrompt - A function that handles the image stacking process with a prompt.
 * - InitialStackFromPromptInput - The input type for the initialStackFromPrompt function.
 * - InitialStackFromPromptOutput - The return type for the initialStackFromPrompt function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const InitialStackFromPromptInputSchema = z.object({
  imageUrls: z
    .array(z.string())
    .describe('Array of image URLs to stack, each URL must be a data URI that must include a MIME type and use Base64 encoding. Expected format: \'data:<mimetype>;base64,<encoded_data>\'.'),
  prompt: z.string().describe('A prompt describing the desired stacked image.'),
});
export type InitialStackFromPromptInput = z.infer<typeof InitialStackFromPromptInputSchema>;

const InitialStackFromPromptOutputSchema = z.object({
  stackedImageUrl: z
    .string()
    .describe('The stacked image as a data URI that must include a MIME type and use Base64 encoding. Expected format: \'data:<mimetype>;base64,<encoded_data>\'.'),
});
export type InitialStackFromPromptOutput = z.infer<typeof InitialStackFromPromptOutputSchema>;

export async function initialStackFromPrompt(input: InitialStackFromPromptInput): Promise<InitialStackFromPromptOutput> {
  return initialStackFromPromptFlow(input);
}

const prompt = ai.definePrompt({
  name: 'initialStackFromPromptPrompt',
  input: {schema: InitialStackFromPromptInputSchema},
  output: {schema: InitialStackFromPromptOutputSchema},
  prompt: `You are an expert astrophotographer and image processing specialist. Your task is to stack the provided astrophotography images to reduce noise and enhance details, guided by the provided prompt.

Images to stack:
{{#each imageUrls}}
  {{media url=this}}
{{/each}}

Instructions: {{{prompt}}}`,
});

const initialStackFromPromptFlow = ai.defineFlow(
  {
    name: 'initialStackFromPromptFlow',
    inputSchema: InitialStackFromPromptInputSchema,
    outputSchema: InitialStackFromPromptOutputSchema,
  },
  async input => {
    const {media} = await ai.generate({
      prompt: [
        ...input.imageUrls.map(imageUrl => ({
          media: {url: imageUrl},
        })),
        {
          text: `Stack these images based on the following prompt: ${input.prompt}`,
        },
      ],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });
    return {stackedImageUrl: media.url!};
  }
);

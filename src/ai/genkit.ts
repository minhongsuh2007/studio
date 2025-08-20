
import { genkit, type Plugin } from 'genkit';
import { googleAI } from 'genkit/googleai';
import { dotprompt, prompt } from 'genkit/dotprompt';
import { geminiPro } from 'genkit/models';

const googleAiPlugin = googleAI({
  apiVersion: ['v1beta'],
});

export const ai = genkit({
  plugins: [googleAiPlugin, dotprompt()],
  models: [geminiPro],
  logLevel: 'debug',
  enableTracing: true,
});

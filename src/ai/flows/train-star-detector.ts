
'use server';
/**
 * @fileOverview A Genkit flow for training a star detection model.
 *
 * - trainStarDetector - A function that trains a TensorFlow.js model.
 * - StarCharacteristics - The input type for the individual star features.
 * - TrainStarDetectorOutput - The return type for the trainStarDetector function.
 */

import { ai } from '@/ai/genkit';
import { z } from 'genkit';
import * as tf from '@tensorflow/tfjs-node';

// Input schema for a single star's characteristics
export const StarCharacteristicsSchema = z.object({
  avgBrightness: z.number(),
  avgContrast: z.number(),
  fwhm: z.number(),
  pixelCount: z.number(),
  centerRGB: z.tuple([z.number(), z.number(), z.number()]),
  patch3x3RGB: z.tuple([z.number(), z.number(), z.number()]),
  patch5x5RGB: z.tuple([z.number(), z.number(), z.number()]),
});
export type StarCharacteristics = z.infer<typeof StarCharacteristicsSchema>;

// Input schema for the entire flow
const TrainStarDetectorInputSchema = z.array(StarCharacteristicsSchema);
type TrainStarDetectorInput = z.infer<typeof TrainStarDetectorInputSchema>;


// --- Feature and Label Generation ---

type Sample = {
  features: number[];
  label: number;
};

function mean(arr: number[]): number {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function featuresFromCharacteristics(c: StarCharacteristics): number[] {
    const f_centerRGB = mean(c.centerRGB || []);
    const f_patch3 = mean(c.patch3x3RGB || []);
    const f_patch5 = mean(c.patch5x5RGB || []);
    return [
        c.avgBrightness ?? 0,
        c.avgContrast ?? 0,
        c.fwhm ?? 0,
        c.pixelCount ?? 0,
        f_centerRGB,
        f_patch3,
        f_patch5,
    ];
}

// Simple heuristic to label data if no labels are provided
function heuristicLabel(samples: {features: number[], label?: number}[]) {
  const fwhms = samples.map(s => s.features[2]);
  const brightness = samples.map(s => s.features[0]);

  const med = (arr: number[]) => {
    const a = arr.slice().sort((x,y)=>x-y);
    const n = a.length;
    return a[Math.floor(n/2)];
  };
  const medFwhm = med(fwhms);
  const medBrightness = med(brightness);

  for (const s of samples) {
    const fwhm = s.features[2];
    const b = s.features[0];
    const px = s.features[3];
    // A typical star has a reasonable FWHM, is relatively bright, and not too large.
    const isStar = (fwhm >= 3 && fwhm <= 8 && b >= medBrightness * 0.7 && px <= 60);
    s.label = isStar ? 1 : 0;
  }
}

// --- Normalization ---

function normalizeFeatures(mat: number[][]) {
  const cols = mat[0].length;
  const means = new Array(cols).fill(0);
  const stds = new Array(cols).fill(0);
  const n = mat.length;
  for (let j=0; j<cols; j++){
    for (let i=0; i<n; i++) means[j] += mat[i][j];
    means[j] /= n;
    for (let i=0; i<n; i++) stds[j] += Math.pow(mat[i][j] - means[j], 2);
    stds[j] = Math.sqrt(stds[j]/n) || 1;
  }
  const norm = mat.map(row => row.map((v,j) => (v - means[j]) / stds[j]));
  return { norm, means, stds };
}

// --- Model Training ---

async function trainTFModel(samples: Sample[], epochs = 30, batchSize = 16) {
    const X = samples.map(s => s.features);
    const y = samples.map(s => s.label);
    
    const { norm, means, stds } = normalizeFeatures(X);

    const xs = tf.tensor2d(norm);
    const ys = tf.tensor2d(y.map(v => [v]));

    const split = Math.floor(norm.length * 0.8);
    const [xTrain, xTest] = [xs.slice([0,0],[split, xs.shape[1]]), xs.slice([split,0],[xs.shape[0]-split, xs.shape[1]])];
    const [yTrain, yTest] = [ys.slice([0,0],[split,1]), ys.slice([split,0],[ys.shape[0]-split,1])];

    const model = tf.sequential();
    model.add(tf.layers.dense({ inputShape: [xs.shape[1]], units: 32, activation: 'relu' }));
    model.add(tf.layers.dropout({ rate: 0.2 }));
    model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));

    model.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
    });

    const history = await model.fit(xTrain, yTrain, {
        epochs,
        batchSize,
        validationData: [xTest, yTest],
        shuffle: true,
    });
    
    const accuracy = history.history.acc ? history.history.acc[epochs - 1] as number : undefined;

    // Serialize model weights for transport
    const modelWeights = model.getWeights().map(w => ({
        name: w.name,
        shape: w.shape,
        dtype: w.dtype,
        values: Array.from(w.dataSync())
    }));

    tf.dispose([model, xs, ys, xTrain, xTest, yTrain, yTest]);

    return { modelWeights, means, stds, accuracy };
}


// --- Genkit Flow Definition ---

export interface ModelWeightData {
    name: string;
    shape: number[];
    dtype: 'float32' | 'int32' | 'bool';
    values: number[];
}

export const TrainStarDetectorOutputSchema = z.object({
  modelWeights: z.array(z.any()), // Simplified for transport
  normalization: z.object({
    means: z.array(z.number()),
    stds: z.array(z.number()),
  }),
  accuracy: z.number().optional(),
});
export type TrainStarDetectorOutput = z.infer<typeof TrainStarDetectorOutputSchema>;

export async function trainStarDetector(
  input: TrainStarDetectorInput
): Promise<TrainStarDetectorOutput> {
  return trainStarDetectorFlow(input);
}


const trainStarDetectorFlow = ai.defineFlow(
  {
    name: 'trainStarDetectorFlow',
    inputSchema: TrainStarDetectorInputSchema,
    outputSchema: TrainStarDetectorOutputSchema,
  },
  async (characteristics) => {
    console.log(`[Flow] Starting training with ${characteristics.length} samples.`);
    
    const samples: {features: number[], label?: number}[] = characteristics.map(c => ({ features: featuresFromCharacteristics(c) }));
    
    // Use heuristic to auto-label the user-provided stars as positive examples
    // This is a simplification; in a real scenario, you'd need negative examples too.
    // For now, we assume all user-clicked stars are good (label=1).
    samples.forEach(s => s.label = 1);

    // To make the model useful, we need negative examples (noise).
    // We will generate some artificial noise samples.
    const noiseSamples: Sample[] = [];
    const numNoiseSamples = Math.max(samples.length, 20); // Create as many noise samples as star samples
    const numFeatures = samples[0].features.length;
    for (let i = 0; i < numNoiseSamples; i++) {
        const noiseFeatures = Array(numFeatures).fill(0).map(() => Math.random() * 50); // Random noise
        noiseSamples.push({ features: noiseFeatures, label: 0 });
    }
    
    const allSamples = [...(samples as Sample[]), ...noiseSamples];

    const { modelWeights, means, stds, accuracy } = await trainTFModel(allSamples);

    console.log(`[Flow] Training complete. Accuracy: ${accuracy}`);

    return {
      modelWeights,
      normalization: { means, stds },
      accuracy,
    };
  }
);

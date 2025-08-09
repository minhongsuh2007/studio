
// This file is used to define types that might be shared between client and server,
// especially for Genkit flow outputs that need to be strongly typed on the client.

// Represents the structure of serialized model weights for transport from server to client.
export interface ModelWeightData {
    name: string;
    shape: number[];
    dtype: 'float32' | 'int32' | 'bool';
    values: number[];
}

// Represents the full output of the trainStarDetectorFlow.
export interface TrainStarDetectorOutput {
  modelWeights: ModelWeightData[];
  normalization: {
    means: number[];
    stds: number[];
  };
  accuracy?: number;
}

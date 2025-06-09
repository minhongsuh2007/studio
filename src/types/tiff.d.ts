declare module 'tiff.js' {
  interface TIFFOptions {
    buffer: ArrayBuffer;
  }

  class TIFF {
    constructor(options: TIFFOptions);
    width(): number;
    height(): number;
    isGrayscale(): boolean;
    /** Returns Uint8Array containing flat RGBA image data. */
    readRGBAImage(): Uint8Array;
    /** Returns an array of TypedArrays, each typed array contains one sample. */
    readSamples(): (Uint8Array | Uint16Array | Uint32Array | Float32Array | Float64Array)[];
  }

  export default TIFF;
}

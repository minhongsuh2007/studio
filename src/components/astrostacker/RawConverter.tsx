
"use client";

import { useState, useCallback } from 'react';
import {
  ImageMagick,
  initialize,
  MagickFormat,
  MagickRead,
} from '@imagemagick/magick-wasm';
import { useDropzone, type Accept } from 'react-dropzone';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { UploadCloud, Loader2, Download, CheckCircle, AlertTriangle } from 'lucide-react';
import { Progress } from '../ui/progress';

interface RawConverterProps {
  isOpen: boolean;
  onClose: () => void;
  onFilesConverted: (files: File[]) => void;
}

interface ConvertedFile {
  originalName: string;
  blob: Blob;
  dataUrl: string;
}

const ACCEPTED_RAW_FORMATS: Accept = {
  'image/fits': ['.fits', '.fit'],
  'image/tiff': ['.tif', '.tiff'],
  'image/x-canon-cr2': ['.cr2'],
  'image/x-canon-cr3': ['.cr3'],
  'image/x-nikon-nef': ['.nef'],
  'image/x-sony-arw': ['.arw'],
  'image/x-fuji-raf': ['.raf'],
  'image/x-panasonic-rw2': ['.rw2'],
  'image/x-olympus-orf': ['.orf'],
  'image/dng': ['.dng'],
};

export function RawConverter({ isOpen, onClose, onFilesConverted }: RawConverterProps) {
  const [filesToConvert, setFilesToConvert] = useState<File[]>([]);
  const [convertedFiles, setConvertedFiles] = useState<ConvertedFile[]>([]);
  const [isConverting, setIsConverting] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [progress, setProgress] = useState(0);

  // Initialize ImageMagick WASM
  useState(() => {
    async function init() {
        await initialize();
        setIsInitialized(true);
    }
    init();
  });

  const handleConvert = async () => {
    if (filesToConvert.length === 0) return;
    setIsConverting(true);
    setConvertedFiles([]);
    setProgress(0);

    const results: ConvertedFile[] = [];

    for (const [index, file] of filesToConvert.entries()) {
      try {
        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);

        const result = await ImageMagick.read(data, async (image) => {
            image.autoOrient();
            await image.write(MagickFormat.Png, (out) => {
              const blob = new Blob([out], { type: 'image/png' });
              results.push({
                originalName: file.name,
                blob: blob,
                dataUrl: URL.createObjectURL(blob),
              });
            });
        });
      } catch (error) {
        console.error(`Error converting ${file.name}:`, error);
        // We just skip the file if it fails
      } finally {
        setProgress(((index + 1) / filesToConvert.length) * 100);
      }
    }
    
    setConvertedFiles(results);
    setIsConverting(false);
  };
  
  const handleDownloadAll = () => {
    convertedFiles.forEach(file => {
      const link = document.createElement('a');
      link.href = file.dataUrl;
      link.download = `${file.originalName.split('.').slice(0, -1).join('.')}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  };

  const handleAddToQueue = () => {
    const files = convertedFiles.map(cf => new File([cf.blob], `${cf.originalName}.png`, { type: 'image/png' }));
    onFilesConverted(files);
    onClose();
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setFilesToConvert(prev => [...prev, ...acceptedFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_RAW_FORMATS,
    multiple: true,
    disabled: isConverting || !isInitialized,
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>RAW File Converter</DialogTitle>
          <DialogDescription>
            Convert FITS, CR2, NEF, and other RAW formats to PNG before stacking.
            This tool uses ImageMagick running directly in your browser.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-4">
          <div className="space-y-4">
            <h3 className="font-semibold">Step 1: Upload RAW Files</h3>
             {!isInitialized ? (
                <div className="p-6 border-2 border-dashed rounded-lg flex flex-col items-center justify-center text-center h-48">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    <p className="mt-2 text-sm text-muted-foreground">Initializing ImageMagick Engine...</p>
                </div>
            ) : (
                <div
                    {...getRootProps()}
                    className={`p-6 border-2 border-dashed rounded-lg cursor-pointer transition-colors duration-200 ease-in-out h-48 flex flex-col items-center justify-center text-center
                        ${isDragActive ? 'border-accent bg-accent/10' : 'border-input hover:border-accent/70'}`}
                >
                    <input {...getInputProps()} />
                    <UploadCloud className={`w-10 h-10 ${isDragActive ? 'text-accent' : 'text-muted-foreground'}`} />
                    <p className="mt-2 text-sm text-muted-foreground">Drag & drop files here, or click to select</p>
                </div>
            )}
             {filesToConvert.length > 0 && (
                <ScrollArea className="h-32 border rounded-md p-2">
                    <ul className="text-sm space-y-1">
                    {filesToConvert.map((file, i) => (
                        <li key={i} className="truncate">{file.name}</li>
                    ))}
                    </ul>
                </ScrollArea>
            )}
            <Button onClick={handleConvert} disabled={isConverting || filesToConvert.length === 0 || !isInitialized} className="w-full">
              {isConverting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Convert {filesToConvert.length} File(s) to PNG
            </Button>
            {isConverting && <Progress value={progress} className="w-full" />}
          </div>
          <div className="space-y-4">
            <h3 className="font-semibold">Step 2: Download or Add to Queue</h3>
            {convertedFiles.length > 0 ? (
                <>
                <ScrollArea className="h-48 border rounded-md p-2">
                    <ul className="text-sm space-y-1">
                        {convertedFiles.map((file, i) => (
                            <li key={i} className="truncate text-green-500 flex items-center gap-2">
                                <CheckCircle className="h-4 w-4" />
                                {file.originalName}.png
                            </li>
                        ))}
                    </ul>
                </ScrollArea>
                <div className="grid grid-cols-2 gap-2">
                    <Button onClick={handleDownloadAll} variant="secondary">
                        <Download className="mr-2 h-4 w-4" /> Download All
                    </Button>
                    <Button onClick={handleAddToQueue}>
                        Add to Stacking Queue
                    </Button>
                </div>
                </>
            ) : (
                <div className="p-6 border-2 border-dashed rounded-lg flex flex-col items-center justify-center text-center h-full">
                    <p className="text-sm text-muted-foreground">Converted PNG files will appear here.</p>
                </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


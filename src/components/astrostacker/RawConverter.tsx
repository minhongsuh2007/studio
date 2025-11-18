
"use client";

import { useState, useCallback } from 'react';
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
  const [isInitialized, setIsInitialized] = useState(true); // Assume initialized
  const [progress, setProgress] = useState(0);

  // ImageMagick logic is removed. This component is now a placeholder.

  const handleConvert = async () => {
    // This functionality is now handled directly in page.tsx
    onClose();
  };
  
  const handleDownloadAll = () => {
    // This functionality is now handled directly in page.tsx
  };

  const handleAddToQueue = () => {
    const files = convertedFiles.map(cf => new File([cf.blob], `${cf.originalName}.png`, { type: 'image/png' }));
    onFilesConverted(files);
    onClose();
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setFilesToConvert(prev => [...prev, ...acceptedFiles]);
    onFilesConverted(acceptedFiles); // Immediately pass to main component
    onClose(); // Close the dialog after selection
  }, [onFilesConverted, onClose]);

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
          <DialogTitle>RAW File Uploader</DialogTitle>
          <DialogDescription>
             Upload FITS, CR2, NEF, and other RAW formats. They will be processed directly.
          </DialogDescription>
        </DialogHeader>
        <div
            {...getRootProps()}
            className={`p-12 border-2 border-dashed rounded-lg cursor-pointer transition-colors duration-200 ease-in-out
                ${isDragActive ? 'border-accent bg-accent/10' : 'border-input hover:border-accent/70'}`}
        >
            <input {...getInputProps()} />
            <div className="flex flex-col items-center justify-center text-center">
                <UploadCloud className={`w-12 h-12 ${isDragActive ? 'text-accent' : 'text-muted-foreground'}`} />
                <p className="mt-4 text-lg text-muted-foreground">Drag & drop RAW files here, or click to select</p>
                <p className="text-xs text-muted-foreground mt-1">Files will be added directly to the queue.</p>
            </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

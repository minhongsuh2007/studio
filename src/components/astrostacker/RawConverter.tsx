
"use client";

// This component is no longer used for ImageMagick conversion.
// It has been repurposed as a simple file uploader dialog for RAW files.
// The actual conversion logic is now handled server-side or by other client-side libraries.

import { useCallback } from 'react';
import { useDropzone, type Accept } from 'react-dropzone';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { UploadCloud } from 'lucide-react';

interface RawConverterProps {
  isOpen: boolean;
  onClose: () => void;
  onFilesAdded: (files: File[]) => void;
}

const ACCEPTED_RAW_FORMATS: Accept = {
  'image/*': [], // Accept all image-like files
};

export function RawConverter({ isOpen, onClose, onFilesAdded }: RawConverterProps) {

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      onFilesAdded(acceptedFiles);
    }
    onClose(); // Close the dialog after files are selected
  }, [onFilesAdded, onClose]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_RAW_FORMATS,
    multiple: true,
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>RAW/FITS File Uploader</DialogTitle>
          <DialogDescription>
             Upload FITS, CR2, NEF, and other RAW formats. The application will attempt to process them.
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
                <p className="text-xs text-muted-foreground mt-1">Files will be added directly to the main queue.</p>
            </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

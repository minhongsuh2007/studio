
"use client";

import type React from 'react';
import { useCallback, useState } from 'react';
import { useDropzone, type Accept } from 'react-dropzone';
import { UploadCloud, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ImageUploadAreaProps {
  onFilesAdded: (files: File[]) => void;
  isProcessing: boolean;
  multiple?: boolean;
  accept?: Accept;
  dropzoneText?: string;
  buttonText?: string;
}

// Temporarily restrict to standard web formats to avoid wasm-imagemagick worker issues.
export const ALL_ACCEPTED_FORMATS: Accept = {
  'image/jpeg': ['.jpeg', '.jpg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'image/tiff': ['.tif', '.tiff'],
  'image/fits': ['.fit', '.fits'],
  'image/x-canon-cr2': ['.cr2'],
  'image/x-nikon-nef': ['.nef'],
  'image/x-sony-arw': ['.arw'],
  'image/x-adobe-dng': ['.dng'],
  'image/x-raw': ['.raw'],
};


export function ImageUploadArea({ 
  onFilesAdded, 
  isProcessing, 
  multiple = true, 
  accept = ALL_ACCEPTED_FORMATS,
  dropzoneText,
  buttonText
}: ImageUploadAreaProps) {
  const [isDragging, setIsDragging] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
        onFilesAdded(acceptedFiles);
    }
    setIsDragging(false);
  }, [onFilesAdded]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept,
    multiple: multiple, 
    disabled: isProcessing,
    noClick: true,
    noKeyboard: true,
    onDragEnter: () => setIsDragging(true),
    onDragLeave: () => setIsDragging(false),
  });
  
  const defaultDropzoneText = multiple ? "Drag & drop images here" : "Drag & drop a single file here";
  const finalDropzoneText = dropzoneText || defaultDropzoneText;

  const defaultButtonText = multiple ? "Files" : "File";
  const finalButtonText = buttonText || `Browse ${defaultButtonText}`;


  return (
    <div
      {...getRootProps()}
      className={`p-6 border-2 border-dashed rounded-lg cursor-pointer transition-colors duration-200 ease-in-out
        ${isDragActive || isDragging ? 'border-accent bg-accent/10' : 'border-input hover:border-accent/70'}
        ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center justify-center space-y-3 text-center">
        <UploadCloud className={`w-12 h-12 ${isDragActive || isDragging ? 'text-accent' : 'text-muted-foreground'}`} />
        <p className={`text-lg font-medium ${isDragActive || isDragging ? 'text-accent' : 'text-foreground'}`}>
            {finalDropzoneText}
        </p>
        <p className="text-sm text-muted-foreground">
          or click the button to select
        </p>
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={isProcessing}
            onClick={open}
          >
          <ImageIcon className="mr-2 h-4 w-4" />
          {finalButtonText}
        </Button>
      </div>
    </div>
  );
}

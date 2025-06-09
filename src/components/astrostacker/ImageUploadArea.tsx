
"use client";

import type React from 'react';
import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { UploadCloud, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input'; // Keep for fallback or explicit click

interface ImageUploadAreaProps {
  onFilesAdded: (files: File[]) => void;
  isProcessing: boolean;
  multiple?: boolean; // Added prop
}

export function ImageUploadArea({ onFilesAdded, isProcessing, multiple = true }: ImageUploadAreaProps) {
  const [isDragging, setIsDragging] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    onFilesAdded(acceptedFiles);
    setIsDragging(false);
  }, [onFilesAdded]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/jpeg': ['.jpeg', '.jpg'],
      'image/png': ['.png'],
      'image/gif': ['.gif'],
      'image/webp': ['.webp'],
      'image/x-adobe-dng': ['.dng'],
      'image/x-raw': ['.dng'], // Some raw might be DNG
      'application/fits': ['.fits', '.fit'], // For FITS files
      'image/fits': ['.fits', '.fit'], // Common alternative MIME type for FITS
    },
    multiple: multiple, 
    disabled: isProcessing,
    onDragEnter: () => setIsDragging(true),
    onDragLeave: () => setIsDragging(false),
  });

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
          {multiple ? "Drag & drop images here" : "Drag & drop a single image here"}
        </p>
        <p className="text-sm text-muted-foreground">
          or click to select {multiple ? "files" : "a file"} (JPG, PNG, FITS, WEBP preferred).
        </p>
        {multiple && (
          <p className="text-xs text-muted-foreground mt-1">
            DNG files may require manual pre-conversion. FITS files are processed using a built-in parser.
          </p>
        )}
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={isProcessing}
            onClick={(e) => {
              // Attempt to find the hidden input and click it programmatically.
              // This is a common pattern for custom file upload UIs.
              const inputElement = document.querySelector('input[type="file"][style*="display: none"]');
              if (inputElement && typeof (inputElement as HTMLInputElement).click === 'function') {
                (inputElement as HTMLInputElement).click();
              }
              e.stopPropagation(); // Prevent dropzone's own click handling if not needed
            }}
          >
          <ImageIcon className="mr-2 h-4 w-4" />
          Browse {multiple ? "Files" : "File"}
        </Button>
      </div>
    </div>
  );
}

    
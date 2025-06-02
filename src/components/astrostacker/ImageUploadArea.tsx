
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
}

export function ImageUploadArea({ onFilesAdded, isProcessing }: ImageUploadAreaProps) {
  const [isDragging, setIsDragging] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    onFilesAdded(acceptedFiles);
    setIsDragging(false);
  }, [onFilesAdded]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': ['.jpeg', '.jpg', '.png', '.gif', '.webp'] },
    multiple: true,
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
          Drag & drop images here
        </p>
        <p className="text-sm text-muted-foreground">
          or click to select files (PNG, JPG, etc.)
        </p>
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={isProcessing}
            onClick={(e) => e.stopPropagation()} // Prevent dropzone activation
          >
          <ImageIcon className="mr-2 h-4 w-4" />
          Browse Files
        </Button>
      </div>
    </div>
  );
}

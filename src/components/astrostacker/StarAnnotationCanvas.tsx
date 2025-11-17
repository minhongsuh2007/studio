
"use client";

import type React from 'react';
import { useRef, useEffect, useCallback } from 'react';
import type { StarCategory, LabeledStar, TestResultStar } from '@/types';

interface StarAnnotationCanvasProps {
  imageUrl: string;
  allStars: LabeledStar[];
  manualStars: (LabeledStar | TestResultStar)[];
  onCanvasClick: (x: number, y: number) => void;
  analysisWidth: number;
  analysisHeight: number;
  categories: StarCategory[];
  isReadOnly?: boolean;
}

export function StarAnnotationCanvas({
  imageUrl,
  allStars,
  manualStars,
  onCanvasClick,
  analysisWidth,
  analysisHeight,
  categories,
  isReadOnly = false,
}: StarAnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const categoryMap = new Map(categories.map(c => [c.id, c]));
  
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = analysisWidth > 0 ? analysisWidth : img.naturalWidth;
      canvas.height = analysisHeight > 0 ? analysisHeight : img.naturalHeight;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Draw all auto-detected stars (faint white)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 1;
      for (const star of allStars) {
        ctx.beginPath();
        ctx.arc(star.x, star.y, 5, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // Draw manually selected/verified stars
      ctx.lineWidth = 2;
      for (const star of manualStars) {
        const category = categoryMap.get(star.categoryId);
        const color = (star as TestResultStar).color || category?.color || 'red';
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(star.x, star.y, 8, 0, 2 * Math.PI);
        ctx.stroke();
      }
    };
    img.src = imageUrl;
  }, [imageUrl, allStars, manualStars, analysisWidth, analysisHeight, categoryMap]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (isReadOnly) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Scale click coordinates to match canvas resolution if display is scaled
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    onCanvasClick(x, y);
  };

  return (
    <div className="w-full h-full overflow-auto bg-black border rounded-md shadow-lg flex items-start justify-start">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ 
            cursor: isReadOnly ? 'grab' : 'crosshair',
            width: '100%',
            height: '100%',
            objectFit: 'contain'
        }}
        data-ai-hint="interactive stars"
      />
    </div>
  );
}

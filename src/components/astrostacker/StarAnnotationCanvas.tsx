
"use client";

import type React from 'react';
import { useRef, useEffect, useCallback } from 'react';
import type { Star } from '@/lib/astro-align';

interface StarAnnotationCanvasProps {
  imageUrl: string;
  allStars: Star[];
  manualStars: Star[];
  onCanvasClick: (x: number, y: number) => void;
  analysisWidth: number;
  analysisHeight: number;
}

export function StarAnnotationCanvas({
  imageUrl,
  allStars,
  manualStars,
  onCanvasClick,
  analysisWidth,
  analysisHeight,
}: StarAnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = analysisWidth;
      canvas.height = analysisHeight;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Draw all detected stars (faint yellow)
      ctx.strokeStyle = "rgba(255, 255, 0, 0.5)";
      ctx.lineWidth = 1;
      for (const star of allStars) {
        ctx.beginPath();
        ctx.arc(star.x, star.y, 3, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // Draw manually selected stars (bright red)
      ctx.strokeStyle = "red";
      ctx.lineWidth = 2;
      for (const star of manualStars) {
        ctx.beginPath();
        ctx.arc(star.x, star.y, 6, 0, 2 * Math.PI);
        ctx.stroke();
      }
    };
    img.src = imageUrl;
  }, [imageUrl, allStars, manualStars, analysisWidth, analysisHeight]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
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
    <div className="w-full h-full flex items-center justify-center bg-black border rounded-md shadow-lg">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ cursor: 'crosshair', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        data-ai-hint="interactive stars"
      />
    </div>
  );
}

    
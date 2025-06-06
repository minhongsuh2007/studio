
"use client";

import type React from 'react';
import { useRef, useEffect, useCallback } from 'react';

export interface Star {
  x: number;
  y: number;
  brightness: number;
  isManuallyAdded?: boolean;
}

interface StarAnnotationCanvasProps {
  imageUrl: string;
  stars: Star[];
  analysisWidth: number;
  analysisHeight: number;
  onCanvasClick: (x: number, y: number) => void;
  canvasDisplayWidth?: number;
  canvasDisplayHeight?: number;
}

const STAR_RADIUS = 5;
const CLICK_TOLERANCE_SQUARED = 10 * 10; // Using squared distance for efficiency

export function StarAnnotationCanvas({
  imageUrl,
  stars,
  analysisWidth,
  analysisHeight,
  onCanvasClick,
  canvasDisplayWidth = 600,
  canvasDisplayHeight,
}: StarAnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const getDisplayDimensions = useCallback((imgNaturalWidth: number, imgNaturalHeight: number) => {
    let displayW = canvasDisplayWidth;
    let displayH = canvasDisplayHeight;

    if (displayH && !displayW) {
      displayW = (imgNaturalWidth / imgNaturalHeight) * displayH;
    } else if (displayW && !displayH) {
      displayH = (imgNaturalHeight / imgNaturalWidth) * displayW;
    } else if (!displayW && !displayH) {
      const maxW = 600; // Default max width if nothing is provided
      if (imgNaturalWidth > maxW) {
        displayW = maxW;
        displayH = (imgNaturalHeight / imgNaturalWidth) * maxW;
      } else {
        displayW = imgNaturalWidth;
        displayH = imgNaturalHeight;
      }
    }
    return { displayW, displayH };
  }, [canvasDisplayWidth, canvasDisplayHeight]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      const {displayW, displayH} = getDisplayDimensions(img.naturalWidth, img.naturalHeight);
      
      canvas.width = displayW;
      canvas.height = displayH;

      ctx.clearRect(0, 0, displayW, displayH);
      ctx.drawImage(img, 0, 0, displayW, displayH);

      const scaleX = displayW / analysisWidth;
      const scaleY = displayH / analysisHeight;

      stars.forEach(star => {
        ctx.beginPath();
        ctx.arc(star.x * scaleX, star.y * scaleY, STAR_RADIUS, 0, 2 * Math.PI);
        ctx.strokeStyle = star.isManuallyAdded ? 'cyan' : 'red';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    };
    img.onerror = () => {
      console.error("Failed to load image for star annotation canvas:", imageUrl);
      if (ctx) {
        const {displayW, displayH} = getDisplayDimensions(analysisWidth, analysisHeight); // Use analysis dimensions as fallback
        canvas.width = displayW;
        canvas.height = displayH;
        ctx.clearRect(0, 0, displayW, displayH);
        ctx.fillStyle = "hsl(var(--card))";
        ctx.fillRect(0, 0, displayW, displayH);
        ctx.fillStyle = "hsl(var(--muted-foreground))";
        ctx.textAlign = "center";
        ctx.font = "16px Inter, sans-serif";
        ctx.fillText("Error loading preview", displayW / 2, displayH / 2);
      }
    };
    img.src = imageUrl;
  }, [imageUrl, stars, analysisWidth, analysisHeight, getDisplayDimensions]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    // Mouse click relative to canvas element
    const displayClickX = event.clientX - rect.left;
    const displayClickY = event.clientY - rect.top;

    // Convert display click coordinates to analysis image coordinates
    const analysisClickX = (displayClickX / canvas.width) * analysisWidth;
    const analysisClickY = (displayClickY / canvas.height) * analysisHeight;
    
    onCanvasClick(analysisClickX, analysisClickY);
  };
  
  // Initial dimensions before image load - might be refined by image aspect ratio
  const {displayW: initialWidth, displayH: initialHeight} = getDisplayDimensions(analysisWidth, analysisHeight);

  return (
    <div className="border rounded-md overflow-hidden shadow-md" style={{width: initialWidth, height: initialHeight, margin: '0 auto'}}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ cursor: 'crosshair', display: 'block', width: '100%', height: '100%'}}
        width={initialWidth} 
        height={initialHeight}
        data-ai-hint="interactive stars"
      />
    </div>
  );
}


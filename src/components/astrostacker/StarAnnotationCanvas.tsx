
"use client";

import type React from 'react';
import { useRef, useEffect, useCallback } from 'react';

export interface Star {
  x: number;
  y: number;
  brightness: number;
  isManuallyAdded?: boolean;
  fwhm?: number; // Added for potential future display
  contrast?: number; // Added for potential future display
}

interface StarAnnotationCanvasProps {
  imageUrl: string;
  stars: Star[];
  analysisWidth: number;
  analysisHeight: number;
  onCanvasClick: (x: number, y: number) => void;
  canvasDisplayWidth?: number;
  canvasDisplayHeight?: number;
  starColorOverride?: string; // New prop for custom star color
}

const STAR_RADIUS = 5;
// CLICK_TOLERANCE_SQUARED is not used in this component directly for click handling,
// but could be useful if this component itself handled removal.
// const CLICK_TOLERANCE_SQUARED = 10 * 10; 

export function StarAnnotationCanvas({
  imageUrl,
  stars,
  analysisWidth,
  analysisHeight,
  onCanvasClick,
  canvasDisplayWidth = 600, // Default display width
  canvasDisplayHeight, // Optional specific display height
  starColorOverride, // New prop
}: StarAnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const getDisplayDimensions = useCallback((imgNaturalWidth: number, imgNaturalHeight: number) => {
    let displayW = canvasDisplayWidth;
    let displayH = canvasDisplayHeight;

    // If only height is given, calculate width to maintain aspect ratio
    if (displayH && !displayW) {
      displayW = (imgNaturalWidth / imgNaturalHeight) * displayH;
    } 
    // If only width is given (or default used), calculate height to maintain aspect ratio
    else if (displayW && !displayH) {
      displayH = (imgNaturalHeight / imgNaturalWidth) * displayW;
    } 
    // If neither is given, use default width and calculate height
    else if (!displayW && !displayH) { 
      const maxW = 600; 
      if (imgNaturalWidth > maxW) {
        displayW = maxW;
        displayH = (imgNaturalHeight / imgNaturalWidth) * maxW;
      } else {
        displayW = imgNaturalWidth;
        displayH = imgNaturalHeight;
      }
    }
    // If both are provided, use them directly (aspect ratio might change)
    // This case is implicitly handled as displayW and displayH would be set.

    return { displayW: Math.max(1, displayW || 0), displayH: Math.max(1, displayH || 0) }; // Ensure non-zero
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

      // Ensure analysisWidth and analysisHeight are not zero to prevent division by zero
      const safeAnalysisWidth = analysisWidth > 0 ? analysisWidth : 1;
      const safeAnalysisHeight = analysisHeight > 0 ? analysisHeight : 1;

      const scaleX = displayW / safeAnalysisWidth;
      const scaleY = displayH / safeAnalysisHeight;

      stars.forEach(star => {
        ctx.beginPath();
        ctx.arc(star.x * scaleX, star.y * scaleY, STAR_RADIUS, 0, 2 * Math.PI);
        ctx.strokeStyle = starColorOverride ? starColorOverride : (star.isManuallyAdded ? 'cyan' : 'red');
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    };
    img.onerror = () => {
      console.error("Failed to load image for star annotation canvas:", imageUrl);
      if (ctx) {
        const {displayW, displayH} = getDisplayDimensions(analysisWidth, analysisHeight); 
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
  }, [imageUrl, stars, analysisWidth, analysisHeight, getDisplayDimensions, starColorOverride]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !onCanvasClick) return; // Check if onCanvasClick is provided

    const rect = canvas.getBoundingClientRect();
    const displayClickX = event.clientX - rect.left;
    const displayClickY = event.clientY - rect.top;

    // Ensure analysisWidth and analysisHeight are not zero
    const safeAnalysisWidth = analysisWidth > 0 ? analysisWidth : 1;
    const safeAnalysisHeight = analysisHeight > 0 ? analysisHeight : 1;
    
    const analysisClickX = (displayClickX / canvas.width) * safeAnalysisWidth;
    const analysisClickY = (displayClickY / canvas.height) * safeAnalysisHeight;
    
    onCanvasClick(analysisClickX, analysisClickY);
  };
  
  const {displayW: initialWidth, displayH: initialHeight} = getDisplayDimensions(analysisWidth, analysisHeight);

  return (
    <div className="border rounded-md overflow-hidden shadow-md bg-muted" style={{width: initialWidth, height: initialHeight, margin: '0 auto'}}>
      <canvas
        ref={canvasRef}
        onClick={onCanvasClick ? handleClick : undefined} // Only attach if onCanvasClick is a function
        style={{ cursor: onCanvasClick ? 'crosshair' : 'default', display: 'block', width: '100%', height: '100%'}}
        width={initialWidth} 
        height={initialHeight}
        data-ai-hint="interactive stars"
      />
    </div>
  );
}


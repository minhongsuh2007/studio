
"use client";

import type React from 'react';
import { useRef, useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Point, Curve, Channel } from '@/types';

interface CurveEditorProps {
    curves: Curve;
    onCurveChange: (channel: Channel, newPoints: Point[]) => void;
    histogram: { r: number, g: number, b: number }[];
}

const CANVAS_SIZE = 256;
const POINT_RADIUS = 5;

const channelColors = {
  rgb: 'white',
  r: '#FF6B6B',
  g: '#4ECDC4',
  b: '#45B7D1',
};

export function CurveEditor({ curves, onCurveChange, histogram }: CurveEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeChannel, setActiveChannel] = useState<Channel>('rgb');
  const [draggingPointIndex, setDraggingPointIndex] = useState<number | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const points = curves[activeChannel];

    // 1. Clear canvas with the appropriate background color
    ctx.fillStyle = activeChannel === 'rgb' ? 'black' : 'hsl(var(--card))';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 2. Draw histogram in the background
    const drawHistogramChannel = (channelKey: 'r' | 'g' | 'b', color: string) => {
        if (!histogram || histogram.length === 0) return;
        const maxHistValue = Math.max(...histogram.map(h => h[channelKey]));
        if (maxHistValue > 0) {
            ctx.fillStyle = `${color}44`; // Use transparent fill
            for (let i = 0; i < 256; i++) {
                const h = (histogram[i][channelKey] / maxHistValue) * CANVAS_SIZE;
                if (h > 0) {
                   ctx.fillRect(i, CANVAS_SIZE - h, 1, h);
                }
            }
        }
    };
    
    if (activeChannel === 'rgb') {
        drawHistogramChannel('r', channelColors.r);
        drawHistogramChannel('g', channelColors.g);
        drawHistogramChannel('b', channelColors.b);
    } else {
        drawHistogramChannel(activeChannel, channelColors[activeChannel]);
    }

    // 3. Draw grid OVER the histogram
    ctx.strokeStyle = 'hsl(var(--border))';
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
        const pos = (i * CANVAS_SIZE) / 4;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, CANVAS_SIZE);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(CANVAS_SIZE, pos);
        ctx.stroke();
    }
    
    // 4. Draw the curve
    ctx.strokeStyle = channelColors[activeChannel];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, CANVAS_SIZE - points[0].y);

    const lut = new Uint8Array(256);
    let p_idx = 0;
    for (let i = 0; i < 256; i++) {
      while (p_idx < points.length - 2 && points[p_idx + 1].x < i) {
        p_idx++;
      }
      const p1 = points[p_idx];
      const p2 = points[p_idx + 1];
      
      let y;
      if (p2.x === p1.x) { y = p2.y; } 
      else {
        const t = (i - p1.x) / (p2.x - p1.x);
        y = p1.y * (1 - t) + p2.y * t;
      }
      lut[i] = y;
      ctx.lineTo(i, CANVAS_SIZE - y);
    }
    ctx.stroke();

    // 5. Draw points
    ctx.fillStyle = channelColors[activeChannel];
    for (const point of points) {
        ctx.beginPath();
        ctx.arc(point.x, CANVAS_SIZE - point.y, POINT_RADIUS, 0, 2 * Math.PI);
        ctx.fill();
    }
  }, [activeChannel, curves, histogram]);

  useEffect(() => {
    draw();
  }, [draw]);

  const getMousePos = (e: React.MouseEvent): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    x = Math.max(0, Math.min(CANVAS_SIZE, x));
    y = Math.max(0, Math.min(CANVAS_SIZE, y));
    return { x, y: CANVAS_SIZE - y };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const pos = getMousePos(e);
    const points = curves[activeChannel];

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (Math.hypot(p.x - pos.x, p.y - pos.y) < POINT_RADIUS * 2) {
        setDraggingPointIndex(i);
        return;
      }
    }
    
    // Add new point
    const newPoints = [...points, pos].sort((a,b) => a.x - b.x);
    onCurveChange(activeChannel, newPoints);
    setDraggingPointIndex(newPoints.findIndex(p => p.x === pos.x && p.y === pos.y));
  };

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (draggingPointIndex === null) return;
    const pos = getMousePos(e);
    const points = [...curves[activeChannel]];
    
    const isEndpoint = draggingPointIndex === 0 || draggingPointIndex === points.length - 1;
    let newX = isEndpoint ? points[draggingPointIndex].x : pos.x;

    const prevPoint = points[draggingPointIndex - 1];
    const nextPoint = points[draggingPointIndex + 1];

    if (prevPoint && newX < prevPoint.x) newX = prevPoint.x + 0.1;
    if (nextPoint && newX > nextPoint.x) newX = nextPoint.x - 0.1;
    
    points[draggingPointIndex] = { x: newX, y: pos.y };

    onCurveChange(activeChannel, points);
  }, [activeChannel, curves, draggingPointIndex, onCurveChange]);

  const handleMouseUp = useCallback(() => {
    setDraggingPointIndex(null);
  }, []);

  const handleDoubleClick = (e: React.MouseEvent) => {
    const pos = getMousePos(e);
    const points = curves[activeChannel];
    
    for (let i = 1; i < points.length - 1; i++) {
        if (Math.hypot(points[i].x - pos.x, points[i].y - pos.y) < POINT_RADIUS * 2) {
            const newPoints = points.filter((_, index) => index !== i);
            onCurveChange(activeChannel, newPoints);
            return;
        }
    }
  };

  const handleResetChannel = () => {
    onCurveChange(activeChannel, [{x:0, y:0}, {x:255, y:255}]);
  };

  return (
    <div className="space-y-2">
      <Tabs value={activeChannel} onValueChange={(v) => setActiveChannel(v as Channel)} className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="rgb">RGB</TabsTrigger>
          <TabsTrigger value="r">R</TabsTrigger>
          <TabsTrigger value="g">G</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
      </Tabs>
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        className="cursor-crosshair rounded-md border"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />
      <Button variant="outline" size="sm" onClick={handleResetChannel} className="w-full">
        Reset {activeChannel.toUpperCase()} Channel
      </Button>
    </div>
  );
}

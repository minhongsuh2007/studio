
"use client";

import type React from 'react';
import { useRef, useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import type { Point, Curve, Channel } from '@/types';

// --- Type Definitions ---
interface CurveEditorProps {
    curves: Curve;
    onCurveChange: (channel: 'rgb', newPoints: Point[]) => void;
    histogram: { r: number; g: number; b: number }[];
}

// --- Constants ---
const CANVAS_SIZE = 256;
const POINT_RADIUS = 5;
const GRID_COLOR = 'hsl(var(--border))';
const RGB_CURVE_COLOR = 'white';
const RGB_BACKGROUND_COLOR = 'black';


// --- Main Component ---
export function CurveEditor({ curves, onCurveChange, histogram }: CurveEditorProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [draggingPointIndex, setDraggingPointIndex] = useState<number | null>(null);

    const activeChannel: Channel = 'rgb'; // Only RGB mode is supported now

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const points = curves[activeChannel];

        // 1. Draw Background
        ctx.fillStyle = RGB_BACKGROUND_COLOR;
        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

        // 2. Draw Histogram
        if (histogram && histogram.length > 0) {
            const maxHistValue = Math.max(...histogram.map(h => Math.max(h.r, h.g, h.b)));
            if (maxHistValue > 0) {
                const histChannels: ('r' | 'g' | 'b')[] = ['r', 'g', 'b'];
                for (const channelKey of histChannels) {
                    const color = { r: '#FF6B6B', g: '#4ECDC4', b: '#45B7D1' }[channelKey];
                    ctx.fillStyle = `${color}44`; // Apply transparency
                    for (let i = 0; i < 256; i++) {
                        const h = (histogram[i][channelKey] / maxHistValue) * CANVAS_SIZE;
                        if (h > 0) {
                           ctx.fillRect(i, CANVAS_SIZE - h, 1, h);
                        }
                    }
                }
            }
        }

        // 3. Draw Grid
        ctx.strokeStyle = GRID_COLOR;
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

        // 4. Draw Curve Line
        ctx.strokeStyle = RGB_CURVE_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
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
          if (i === 0) {
            ctx.moveTo(i, CANVAS_SIZE - y);
          } else {
            ctx.lineTo(i, CANVAS_SIZE - y);
          }
        }
        ctx.stroke();

        // 5. Draw Points
        ctx.fillStyle = RGB_CURVE_COLOR;
        for (const point of points) {
            ctx.beginPath();
            ctx.arc(point.x, CANVAS_SIZE - point.y, POINT_RADIUS, 0, 2 * Math.PI);
            ctx.fill();
        }
    }, [curves, histogram]);

    useEffect(() => {
        const animationFrameId = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(animationFrameId);
    }, [draw]);

    const getMousePos = (e: React.MouseEvent): Point => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;
        x = Math.round(Math.max(0, Math.min(CANVAS_SIZE, x)));
        y = Math.round(Math.max(0, Math.min(CANVAS_SIZE, y)));
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

        const newPoints = [...points, pos].sort((a, b) => a.x - b.x);
        onCurveChange(activeChannel, newPoints);
        setDraggingPointIndex(newPoints.findIndex(p => p.x === pos.x && p.y === pos.y));
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (draggingPointIndex === null) return;
        const pos = getMousePos(e);
        const points = [...curves[activeChannel]];

        const isEndpoint = draggingPointIndex === 0 || draggingPointIndex === points.length - 1;
        let newX = isEndpoint ? points[draggingPointIndex].x : pos.x;

        const prevPoint = points[draggingPointIndex - 1];
        const nextPoint = points[draggingPointIndex + 1];

        if (prevPoint && newX <= prevPoint.x) newX = prevPoint.x + 0.1;
        if (nextPoint && newX >= nextPoint.x) newX = nextPoint.x - 0.1;

        points[draggingPointIndex] = { x: newX, y: pos.y };

        onCurveChange(activeChannel, points);
    };

    const handleMouseUp = () => {
        setDraggingPointIndex(null);
    };

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
        onCurveChange(activeChannel, [{ x: 0, y: 0 }, { x: 255, y: 255 }]);
    };

    return (
        <div className="space-y-2">
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
                Reset Curve
            </Button>
        </div>
    );
}

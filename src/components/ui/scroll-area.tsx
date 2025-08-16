"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("relative overflow-auto", className)}
    {...props}
  >
    <div className="h-full w-full">{children}</div>
    {/* ScrollBar component is now for visual representation if needed, but native scroll is used */}
  </div>
));
ScrollArea.displayName = "ScrollArea";

const ScrollBar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "vertical" | "horizontal" }
>(({ className, orientation = "vertical", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex touch-none select-none transition-colors",
      // These classes are for styling a custom scrollbar, but we use native.
      // They can be adapted if a custom scrollbar is re-introduced.
      // For now, they won't do much.
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    {/* Thumb would go here for custom scrollbar */}
  </div>
));
ScrollBar.displayName = "ScrollBar";

export { ScrollArea, ScrollBar };

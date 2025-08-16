"use client"

import * as React from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  onCheckedChange?: (checked: boolean) => void;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => {
    const internalId = React.useId();
    const id = props.id || internalId;

    return (
      <div className="flex items-center">
        <input
          type="checkbox"
          id={id}
          ref={ref}
          checked={checked}
          onChange={(e) => onCheckedChange?.(e.target.checked)}
          className="sr-only" // Hide the default checkbox
          {...props}
        />
        <label
          htmlFor={id}
          className={cn(
            "peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            "flex items-center justify-center cursor-pointer",
            checked ? "bg-primary text-primary-foreground" : "",
            className
          )}
        >
          {checked && <Check className="h-4 w-4" />}
        </label>
      </div>
    );
  }
);
Checkbox.displayName = "Checkbox"

export { Checkbox }

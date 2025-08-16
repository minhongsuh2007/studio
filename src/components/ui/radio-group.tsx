"use client"

import * as React from "react"
import { Circle } from "lucide-react"

import { cn } from "@/lib/utils"

type RadioGroupContextValue = {
  name?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}
const RadioGroupContext = React.createContext<RadioGroupContextValue>({});

const RadioGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    name?: string;
  }
>(({ className, value, onValueChange, disabled, name, ...props }, ref) => {
  return (
    <RadioGroupContext.Provider value={{ value, onValueChange, disabled, name }}>
      <div ref={ref} className={cn("grid gap-2", className)} {...props} role="radiogroup" />
    </RadioGroupContext.Provider>
  )
})
RadioGroup.displayName = "RadioGroup"

const RadioGroupItem = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> & { value: string }
>(({ className, value, ...props }, ref) => {
  const context = React.useContext(RadioGroupContext);
  const checked = context.value === value;

  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={() => context.onValueChange?.(value)}
      disabled={props.disabled ?? context.disabled}
      className={cn(
        "aspect-square h-4 w-4 rounded-full border border-primary text-primary ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {checked && (
        <div className="flex items-center justify-center">
          <Circle className="h-2.5 w-2.5 fill-current text-current" />
        </div>
      )}
    </button>
  )
})
RadioGroupItem.displayName = "RadioGroupItem"

export { RadioGroup, RadioGroupItem }

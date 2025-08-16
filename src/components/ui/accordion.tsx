"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

const AccordionContext = React.createContext<{
  openItems: string[];
  setOpenItems: React.Dispatch<React.SetStateAction<string[]>>;
  type: "single" | "multiple";
}>({
  openItems: [],
  setOpenItems: () => {},
  type: "single",
});

const Accordion = ({
  className,
  type = "single",
  defaultValue,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  type?: "single" | "multiple";
  defaultValue?: string | string[];
}) => {
  const [openItems, setOpenItems] = React.useState<string[]>(
    defaultValue ? (Array.isArray(defaultValue) ? defaultValue : [defaultValue]) : []
  );

  return (
    <AccordionContext.Provider value={{ openItems, setOpenItems, type }}>
      <div className={cn("w-full", className)} {...props} />
    </AccordionContext.Provider>
  );
};

const AccordionItemContext = React.createContext<string>("");

const AccordionItem = ({
  className,
  value,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { value: string }) => (
  <AccordionItemContext.Provider value={value}>
    <div className={cn("border-b", className)} {...props} />
  </AccordionItemContext.Provider>
);

const AccordionTrigger = ({
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  const { openItems, setOpenItems, type } = React.useContext(AccordionContext);
  const value = React.useContext(AccordionItemContext);
  const isOpen = openItems.includes(value);

  const handleClick = () => {
    setOpenItems(prev => {
      if (type === "single") {
        return prev.includes(value) ? [] : [value];
      }
      return prev.includes(value) ? prev.filter(item => item !== value) : [...prev, value];
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-expanded={isOpen}
      className={cn(
        "flex w-full flex-1 items-center justify-between py-4 font-medium transition-all hover:underline",
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown
        className={cn(
          "h-4 w-4 shrink-0 transition-transform duration-200",
          isOpen && "rotate-180"
        )}
      />
    </button>
  );
};

const AccordionContent = ({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => {
  const { openItems } = React.useContext(AccordionContext);
  const value = React.useContext(AccordionItemContext);
  const isOpen = openItems.includes(value);

  return (
    <div
      className={cn(
        "overflow-hidden text-sm transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
        isOpen ? "animate-accordion-down" : "animate-accordion-up h-0"
      )}
      {...props}
    >
      <div className={cn("pb-4 pt-0", className)}>{children}</div>
    </div>
  );
};

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }

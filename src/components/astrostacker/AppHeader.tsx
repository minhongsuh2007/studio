import { Rocket } from 'lucide-react';

export function AppHeader() {
  return (
    <header className="py-4 px-6 border-b border-border sticky top-0 bg-background/80 backdrop-blur-md z-10">
      <div className="container mx-auto flex items-center gap-2">
        <Rocket className="h-7 w-7 text-accent" />
        <h1 className="text-2xl font-headline font-semibold text-foreground">
          AstroStacker
        </h1>
      </div>
    </header>
  );
}

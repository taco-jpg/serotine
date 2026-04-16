"use client"

import { useState, useEffect } from 'react';

export function IdentityIcon({ pubKey, size = 32 }: { pubKey: string, size?: number }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !pubKey) {
    return <div className="rounded-full bg-zinc-900 border border-zinc-800 flex-shrink-0" style={{ width: size, height: size }} />;
  }
  
  // Simple deterministic color generation from pubKey hex string
  const hash = pubKey.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  const saturation = 60 + (hash % 20);
  const lightness = 40 + (hash % 20);
  
  return (
    <div 
      className="rounded-full overflow-hidden border border-zinc-800 flex-shrink-0 shadow-sm flex items-center justify-center p-1"
      style={{ 
        width: size, 
        height: size,
        background: `linear-gradient(135deg, hsl(${hue}, ${saturation}%, ${lightness}%), hsl(${(hue + 40) % 360}, ${saturation}%, ${lightness - 10}%))`
      }}
    >
      <div className="w-full h-full rounded-full bg-black/20 backdrop-blur-[1px]" />
    </div>
  );
}


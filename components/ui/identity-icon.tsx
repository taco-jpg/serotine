"use client"

import { useState, useEffect } from 'react';

export function IdentityIcon({ pubKey, size = 32 }: { pubKey: string, size?: number }) {
  const [svgString, setSvgString] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let active = true;
    setMounted(true);
    if (pubKey) {
      // Dynamically import to prevent Edge runtime from evaluating node/browser APIs during SSR
      import('jdenticon').then((jdenticon) => {
        if (active) {
          setSvgString(jdenticon.toSvg(pubKey, size));
        }
      }).catch(err => console.error("Failed to load jdenticon:", err));
    }
    return () => { active = false; };
  }, [pubKey, size]);

  if (!mounted || !pubKey || !svgString) {
    return <div className="rounded-full bg-zinc-900 border border-zinc-800 flex-shrink-0" style={{ width: size, height: size }} />;
  }
  
  return (
    <div 
      className="rounded-full overflow-hidden border border-zinc-800 bg-zinc-900 flex-shrink-0 flex items-center justify-center shadow-sm"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svgString }} 
    />
  );
}


'use client';

import { useState, useEffect } from 'react';

export default function Header() {
  const [now, setNow] = useState<string>('');

  useEffect(() => {
    const update = () => setNow(new Date().toLocaleTimeString('en-US', { hour12: false }));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="h-14 bg-card border-b border-border px-6 flex items-center justify-between">
      <h2 className="text-sm font-medium text-muted-foreground">Pulse</h2>
      <div className="text-xs text-muted-foreground font-mono">{now} UTC</div>
    </header>
  );
}

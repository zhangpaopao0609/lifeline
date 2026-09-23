import { Broadcast } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

/** P8a: relay disconnected — full-screen page: brand + red status dot + auto-reconnect; after 30s show a "check the network" hint. */
export function ReconnectPage() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(setSlow, 30_000, true);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="flex h-full min-h-[100dvh] flex-col items-center justify-center gap-3.5 bg-[var(--bg-0)]">
      <div className="flex items-center gap-2 font-bold tracking-wide">
        <Broadcast size={20} color="var(--accent)" />
        Lifeline
      </div>
      <span className="h-2.5 w-2.5 rounded-full bg-[var(--error)]" />
      <div className="text-[var(--text-secondary)]">与服务器断开，重连中…</div>
      {slow && <div className="text-[length:var(--text-chrome)] text-[var(--text-weak)]">一直连不上？检查一下网络。</div>}
    </div>
  );
}

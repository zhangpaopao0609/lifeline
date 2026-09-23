import { Check, Copy } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(setCopied, 1500, false);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={`btn btn-ghost min-h-11 gap-1 !py-1.5 lg:min-h-8 ${copied ? 'text-[var(--ok)]' : ''}`}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? '已复制' : label}
    </button>
  );
}

import { useEffect, useState } from 'react';

/**
 * Avatar rules (inherited decisions 3/5):
 *  - only shown where "who you signed in as" is displayed, never inside a message bubble;
 *  - empty src (server has no AUTH_AVATAR_URL) or a load failure both fall back to a solid initial block;
 *    never show a broken image.
 */
export function Avatar({ src, name, size = 28 }: { src: string; name: string; size?: 28 | 40 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const box = { width: size, height: size } as const;
  if (!src || failed) {
    return (
      <span
        aria-label={name}
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] font-semibold text-[var(--accent)] ${size === 40 ? 'text-base' : 'text-xs'}`}
        style={box}
      >
        {initial}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={name}
      onError={() => setFailed(true)}
      className="block shrink-0 rounded-full object-cover"
      style={box}
    />
  );
}

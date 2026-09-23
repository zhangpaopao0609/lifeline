import { useUiStore } from '../store/ui';

/** Toast host: bottom-centered overlay (spec §8 Toast in the component list) */
export function ToastHost() {
  const toasts = useUiStore(s => s.toasts);
  const dismiss = useUiStore(s => s.dismissToast);
  if (toasts.length === 0)
    return null;
  return (
    <div className="toast-stack">
      {toasts.map(t => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={`toast ${t.kind === 'error' ? 'toast-error' : ''}`}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

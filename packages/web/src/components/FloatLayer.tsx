import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { useIsDesktop } from '../hooks/useMediaQuery';

/**
 * Overlay funnel: positioning and interaction all go to Radix (includes Floating UI); styles still come from tokens.css:
 *  - popover (default, desktop only): floats next to the trigger. Flip, collision shift, outside-click close, Esc, aria are Radix's job
 *  - modal: centered desktop dialog (Radix Dialog, with focus trap)
 *  - mobile: both of the above become a bottom sheet (Dialog + layer-sheet styles)
 *
 * The trigger button must be passed as `trigger`; don't write your own onClick to setState:
 * Radix uses Trigger to tell "toggle click" from "outside click". With a homemade onClick, the previous overlay's
 * outside-click close and the new overlay's open write the same state, and the former overwrites the latter —
 * "click another ⋯ while one is open, menu doesn't appear" (reproduced 2026-09-16).
 */
export function FloatLayer({
  trigger,
  open,
  onOpenChange,
  children,
  align = 'left',
  side = 'bottom',
  variant = 'popover',
  label = '对话框',
  contentClassName,
}: {
  /** Trigger element: handed to Radix Trigger (auto-fills aria-expanded / aria-controls and click toggle). */
  trigger?: ReactNode;
  /** Controlled open; if omitted, modal defaults open (caller mounts/unmounts) and popover defaults closed. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  /** Which side to float on: bottom = below, right = to the right (Radix flips if there isn't room). */
  side?: 'bottom' | 'right';
  /** How to align with the trigger: horizontal when side=bottom; vertically top-aligned when side=right. */
  align?: 'left' | 'right';
  variant?: 'popover' | 'modal';
  /** Accessible title (visually hidden): Radix Dialog requires a Title. */
  label?: string;
  /**
   * Extra class on the overlay container (width, e.g. a narrower dialog). **Desktop only**: the phone breakpoint
   * is an inset-x-0 full-width bottom sheet, and a width class would squeeze it into a left-aligned narrow strip.
   */
  contentClassName?: string;
}) {
  const isDesktop = useIsDesktop();
  const shown = open ?? variant === 'modal';

  if (isDesktop && variant === 'popover') {
    if (!trigger)
      return null;
    return (
      <Popover.Root open={shown} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={`layer-popover ${contentClassName ?? ''}`}
            side={side}
            align={side === 'right' ? 'start' : align === 'right' ? 'end' : 'start'}
            sideOffset={6}
            collisionPadding={8}
            onOpenAutoFocus={e => e.preventDefault()}
          >
            {children}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }

  const sheet = !isDesktop;
  return (
    <Dialog.Root open={shown} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className={sheet ? 'layer-sheet-scrim' : 'modal-scrim'} />
        <Dialog.Content
          aria-describedby={undefined}
          className={
            sheet
              ? 'anim-sheet layer-sheet fixed inset-x-0 bottom-0 z-50'
              : `anim-popover modal-card fixed left-1/2 top-1/2 z-[70] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-4 ${contentClassName ?? ''}`
          }
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

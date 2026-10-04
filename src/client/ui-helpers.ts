import type { ConversationUsage } from '../shared/providers';
// Small, DOM-free helpers so the behaviour can be unit-tested without a browser.

/** True when a scroll container is within `threshold` px of its bottom. */
export function isNearBottom(
  {
    scrollTop,
    scrollHeight,
    clientHeight,
  }: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 80,
) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * Whether Enter in the chat composer should send. IME composition never
 * sends, and on touch devices Enter inserts a newline (the send button sends).
 */
export function shouldSendOnEnter({
  key,
  shiftKey,
  isComposing,
  coarsePointer,
}: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  coarsePointer: boolean;
}) {
  return key === 'Enter' && !shiftKey && !isComposing && !coarsePointer;
}

/** Matches a media query, returning false outside the browser. */
export function matchesMedia(query: string) {
  try {
    return (
      typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
    );
  } catch {
    return false;
  }
}

export const isCoarsePointer = () => matchesMedia('(pointer: coarse)');

/** Hostname for display, or the raw value when it is not a valid URL. */
export function sourceHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 1_050_000 → "1.05M", 400_000 → "400k", 12_345 → "12.3k". */
export function formatTokens(count: number) {
  if (count >= 1_000_000)
    return `${Number((count / 1_000_000).toPrecision(3))}M`;
  if (count >= 1_000) return `${Number((count / 1_000).toPrecision(3))}k`;
  return String(Math.round(count));
}

/** "gpt-5.5 · 12.3k / 1.05M context (1%) · 45k tokens used" */
export function usageSummary(usage: ConversationUsage) {
  if (!usage.model) return '';
  const parts = [usage.model];
  if (usage.calls)
    parts.push(
      usage.contextWindow
        ? `${formatTokens(usage.contextTokens)} / ${formatTokens(usage.contextWindow)} context (${Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100))}%)`
        : `${formatTokens(usage.contextTokens)} context`,
      `${formatTokens(usage.inputTokens + usage.outputTokens)} tokens used`,
    );
  else if (usage.contextWindow)
    parts.push(`${formatTokens(usage.contextWindow)} context`);
  return parts.join(' · ');
}

/**
 * Backdrop handlers that close a modal only for a click that both starts and
 * ends on the backdrop. A text selection dragged out of the modal ends with a
 * click on the backdrop too, and must not discard the form.
 */
export function backdropHandlers(onClose: () => void) {
  type Target = { target: unknown; currentTarget: { dataset: DOMStringMap } };
  return {
    onMouseDown: (event: Target) => {
      event.currentTarget.dataset.pressed = String(
        event.target === event.currentTarget,
      );
    },
    onClick: (event: Target) => {
      const pressed = event.currentTarget.dataset.pressed;
      delete event.currentTarget.dataset.pressed;
      // No mousedown recorded (keyboard or synthetic click): close as before.
      if (event.target === event.currentTarget && pressed !== 'false')
        onClose();
    },
  };
}

/**
 * True while the session-expired sign-in overlay is up (or the event came from
 * inside it). Dialog Escape handlers must ignore keys then: the overlay sits on
 * top, and closing the dialog underneath would discard its form.
 */
export function sessionOverlayOpen(target?: unknown) {
  const element = target as { closest?: (selector: string) => unknown };
  if (
    typeof element?.closest === 'function' &&
    element.closest('.session-overlay')
  )
    return true;
  return (
    typeof document !== 'undefined' &&
    !!document.querySelector('.session-overlay')
  );
}

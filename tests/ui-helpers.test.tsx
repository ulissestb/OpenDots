import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  backdropHandlers,
  isCoarsePointer,
  isNearBottom,
  matchesMedia,
  sessionOverlayOpen,
  shouldSendOnEnter,
  sourceHost,
} from '../src/client/ui-helpers';
import { LoginScreen } from '../src/client/Login';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('follows the transcript only near the bottom', () => {
  expect(
    isNearBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 600 }),
  ).toBe(true);
  expect(
    isNearBottom({ scrollTop: 830, scrollHeight: 1500, clientHeight: 600 }),
  ).toBe(true);
  expect(
    isNearBottom({ scrollTop: 800, scrollHeight: 1500, clientHeight: 600 }),
  ).toBe(false);
  expect(
    isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 }),
  ).toBe(true);
});

it('sends on Enter only on fine pointers and outside IME composition', () => {
  const base = {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    coarsePointer: false,
  };
  expect(shouldSendOnEnter(base)).toBe(true);
  expect(shouldSendOnEnter({ ...base, shiftKey: true })).toBe(false);
  expect(shouldSendOnEnter({ ...base, isComposing: true })).toBe(false);
  expect(shouldSendOnEnter({ ...base, coarsePointer: true })).toBe(false);
  expect(shouldSendOnEnter({ ...base, key: 'a' })).toBe(false);
});

it('treats missing or failing matchMedia as a fine pointer', () => {
  expect(matchesMedia('(pointer: coarse)')).toBe(false);
  vi.stubGlobal('window', {
    matchMedia: () => {
      throw new Error('unsupported');
    },
  });
  expect(isCoarsePointer()).toBe(false);
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
  });
  expect(isCoarsePointer()).toBe(true);
});

it('shows a hostname for sources without throwing on bad URLs', () => {
  expect(sourceHost('https://example.com/a?b=1')).toBe('example.com');
  expect(sourceHost('not a url')).toBe('not a url');
  expect(sourceHost('')).toBe('');
});

it('explains an expired session on the sign-in overlay', () => {
  const html = renderToStaticMarkup(
    <LoginScreen onSignedIn={() => {}} notice="Your session ended." />,
  );
  expect(html).toContain('Your session ended.');
  expect(html).not.toContain('Sign in to OpenDots.');
});

describe('backdropHandlers', () => {
  const backdrop = () => ({ dataset: {} as DOMStringMap });
  it('closes only for a click that starts and ends on the backdrop', () => {
    const onClose = vi.fn();
    const handlers = backdropHandlers(onClose);
    const target = backdrop();
    handlers.onMouseDown({ target: {}, currentTarget: target });
    handlers.onClick({ target, currentTarget: target });
    expect(onClose).not.toHaveBeenCalled();
    handlers.onMouseDown({ target, currentTarget: target });
    handlers.onClick({ target, currentTarget: target });
    expect(onClose).toHaveBeenCalledTimes(1);
    handlers.onClick({ target: {}, currentTarget: target });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

it('ignores dialog Escape while the session overlay is open', () => {
  const inside = {
    closest: (selector: string) => selector === '.session-overlay',
  };
  const outside = { closest: () => null };
  let overlay: unknown = null;
  vi.stubGlobal('document', { querySelector: () => overlay });
  expect(sessionOverlayOpen(outside)).toBe(false);
  expect(sessionOverlayOpen(undefined)).toBe(false);
  expect(sessionOverlayOpen(inside)).toBe(true);
  overlay = {};
  expect(sessionOverlayOpen(outside)).toBe(true);
});

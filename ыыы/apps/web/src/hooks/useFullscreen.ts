import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type FullscreenMode = 'none' | 'native' | 'viewport';
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type WebkitDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
const currentFullscreen = () => document.fullscreenElement || (document as WebkitDocument).webkitFullscreenElement || null;

/** Native fullscreen where supported; a fixed viewport fallback covers iPhone Safari and embedded browsers. */
export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [mode, setMode] = useState<FullscreenMode>('none');
  const [busy, setBusy] = useState(false);
  const modeRef = useRef<FullscreenMode>('none');
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const triggerRef = useRef<HTMLElement | null>(null);
  const updateMode = useCallback((value: FullscreenMode) => { modeRef.current = value; if (mountedRef.current) setMode(value); }, []);

  const exit = useCallback(async () => {
    if (currentFullscreen() === target.current) {
      const method = document.exitFullscreen || (document as WebkitDocument).webkitExitFullscreen;
      try { await method?.call(document); } catch { /* Browser Escape remains available if exit is denied. */ }
      if (currentFullscreen() === target.current) return;
    }
    updateMode('none');
    requestAnimationFrame(() => { if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true }); });
  }, [target, updateMode]);

  const toggle = useCallback(async () => {
    if (pendingRef.current) return;
    if (modeRef.current !== 'none') { await exit(); return; }
    const element = target.current as WebkitElement | null;
    if (!element) return;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pendingRef.current = true;
    setBusy(true);
    const request = element.requestFullscreen || element.webkitRequestFullscreen;
    try {
      if (!request) throw new Error('Viewport fullscreen');
      await request.call(element);
      if (mountedRef.current) updateMode(currentFullscreen() === element ? 'native' : 'viewport');
    } catch {
      if (mountedRef.current) updateMode('viewport');
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [target, exit, updateMode]);

  useEffect(() => {
    mountedRef.current = true;
    const change = () => {
      if (currentFullscreen() === target.current && target.current) updateMode('native');
      else if (modeRef.current === 'native') updateMode('none');
    };
    const keydown = (event: KeyboardEvent) => {
      if (modeRef.current === 'none') return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); void exit();
      } else if (event.key === 'Tab') {
        const controls = Array.from(target.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])') || []).filter(element => element.getClientRects().length > 0);
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('fullscreenchange', change);
    document.addEventListener('webkitfullscreenchange', change);
    document.addEventListener('keydown', keydown, true);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('fullscreenchange', change);
      document.removeEventListener('webkitfullscreenchange', change);
      document.removeEventListener('keydown', keydown, true);
      if (currentFullscreen() === target.current) {
        const method = document.exitFullscreen || (document as WebkitDocument).webkitExitFullscreen;
        try { Promise.resolve(method?.call(document)).catch(() => {}); } catch { /* The browser also exits when the target is removed. */ }
      }
    };
  }, [target, exit, updateMode]);

  useEffect(() => {
    if (mode === 'none' || !target.current) return;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const siblings = new Map<HTMLElement, boolean>();
    let branch: HTMLElement | null = target.current;
    while (branch && branch !== document.body) {
      for (const sibling of Array.from(branch.parentElement?.children || [])) {
        if (sibling !== branch && sibling instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) {
          siblings.set(sibling, sibling.inert); sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
      for (const [element, value] of siblings) element.inert = value;
    };
  }, [mode, target]);

  return { active: mode !== 'none', mode, busy, toggle, exit };
}

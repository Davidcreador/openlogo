import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]"),
  );
}

/**
 * Modal keyboard contract shared by editor dialogs: initial focus, trapped
 * Tab order, Escape dismissal, and focus restoration to the trigger.
 */
export function useModalDialog({
  open,
  onClose,
  dialogRef,
  initialFocusRef,
  fallbackFocusSelector,
}: {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Used when the opener lived in a menu that unmounted as the dialog opened. */
  fallbackFocusSelector?: string;
}) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusFrame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const requestedInitial = initialFocusRef?.current;
      const initial =
        requestedInitial &&
        !requestedInitial.matches(
          ":disabled, [aria-hidden='true'], [tabindex='-1']",
        )
          ? requestedInitial
          : (focusableElements(dialog)[0] ?? dialog);
      initial.focus();
    });

    function onKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      requestAnimationFrame(() => {
        const fallback = fallbackFocusSelector
          ? document.querySelector<HTMLElement>(fallbackFocusSelector)
          : null;
        const previousIsUseful =
          previousFocus?.isConnected &&
          previousFocus !== document.body &&
          previousFocus !== document.documentElement;
        const target = previousIsUseful ? previousFocus : fallback;
        target?.focus();
      });
    };
  }, [dialogRef, fallbackFocusSelector, initialFocusRef, open]);
}

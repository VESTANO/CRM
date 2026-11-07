import { useEffect, useRef } from "react";
import { lockDocumentScroll } from "../utils/documentScrollLock.js";

const dialogs = [];

function focusableElements(dialog) {
  if (!dialog) return [];
  return [...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.closest('[hidden], [inert]') && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
}

export function useDialogFocus({ open, dialogRef, initialFocusRef, onCancel, busy = false }) {
  const latest = useRef({ onCancel, busy });
  latest.current = { onCancel, busy };
  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    const previouslyFocused = document.activeElement;
    const releaseScroll = lockDocumentScroll();
    dialogs.push(token);
    const isTopDialog = () => dialogs.at(-1) === token;
    const focusFirst = () => {
      const items = focusableElements(dialogRef.current);
      const initial = initialFocusRef?.current;
      (items.includes(initial) ? initial : items[0] || dialogRef.current)?.focus();
    };
    const focusTimer = window.setTimeout(focusFirst, 0);
    const handleFocus = (event) => {
      if (isTopDialog() && !dialogRef.current?.contains(event.target)) focusFirst();
    };
    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (!latest.current.busy) latest.current.onCancel?.();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableElements(dialogRef.current);
      const current = document.activeElement;
      if (!items.length) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (!dialogRef.current?.contains(current) || !items.includes(current)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0]).focus();
      } else if (event.shiftKey && current === items[0]) {
        event.preventDefault(); items.at(-1).focus();
      } else if (!event.shiftKey && current === items.at(-1)) {
        event.preventDefault(); items[0].focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocus);
      dialogs.splice(dialogs.indexOf(token), 1);
      releaseScroll();
      if (previouslyFocused?.isConnected) previouslyFocused.focus?.();
    };
  }, [open, dialogRef, initialFocusRef]);
}

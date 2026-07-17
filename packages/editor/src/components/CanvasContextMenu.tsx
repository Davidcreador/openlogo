import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  COMMANDS,
  formatShortcut,
  isCommandAvailable,
  type CommandAvailability,
  type CommandId,
} from "../lib/commands-registry";

const SELECTION_COMMANDS: readonly (CommandId | "divider")[] = [
  "edit.cut",
  "edit.copy",
  "edit.paste",
  "edit.duplicate",
  "divider",
  "arrange.forward",
  "arrange.backward",
  "divider",
  "edit.group",
  "edit.ungroup",
  "edit.delete",
];

const EMPTY_COMMANDS: readonly CommandId[] = [
  "edit.paste",
  "edit.select-all",
  "view.fit",
];

export type CanvasMenuState = {
  x: number;
  y: number;
  hasNode: boolean;
};

export function CanvasContextMenu({
  menu,
  availability,
  onClose,
  onRun,
}: {
  menu: CanvasMenuState;
  availability: CommandAvailability;
  onClose: () => void;
  onRun: (id: CommandId) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef(true);
  const returnFocusRef = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const ids = menu.hasNode ? SELECTION_COMMANDS : EMPTY_COMMANDS;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const padding = 8;
    const bounds = element.getBoundingClientRect();
    setPosition({
      left: Math.max(
        padding,
        Math.min(menu.x, window.innerWidth - bounds.width - padding),
      ),
      top: Math.max(
        padding,
        Math.min(menu.y, window.innerHeight - bounds.height - padding),
      ),
    });
    element.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [menu.x, menu.y]);

  useEffect(() => {
    function closeOnOutsidePress(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        restoreFocusRef.current = false;
        onCloseRef.current();
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    }
    window.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape, true);
      if (restoreFocusRef.current) {
        requestAnimationFrame(() => returnFocusRef.current?.focus());
      }
    };
  }, []);

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      ) ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let next: number | null = null;
    if (event.key === "ArrowDown") {
      next = (current + 1 + buttons.length) % buttons.length;
    }
    if (event.key === "ArrowUp") {
      next = (current - 1 + buttons.length) % buttons.length;
    }
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = buttons.length - 1;
    if (next !== null) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  }

  return (
    <div
      ref={menuRef}
      className="menu canvas-context-menu"
      style={{ left: position.left, top: position.top }}
      role="menu"
      aria-label={menu.hasNode ? "Selection actions" : "Canvas actions"}
      onKeyDown={moveFocus}
    >
      {ids.map((id, index) => {
        if (id === "divider") {
          return <div key={`divider-${index}`} className="menu-divider" />;
        }
        const command = COMMANDS.find((item) => item.id === id)!;
        const enabled = isCommandAvailable(id, availability);
        return (
          <button
            key={id}
            type="button"
            className="menu-item"
            role="menuitem"
            disabled={!enabled}
            onClick={() => {
              onClose();
              onRun(id);
            }}
          >
            <span className="menu-label">{command.label}</span>
            {command.shortcut && (
              <kbd>{formatShortcut(command.shortcut)}</kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}

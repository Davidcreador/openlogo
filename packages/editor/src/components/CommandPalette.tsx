import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import {
  COMMAND_GROUPS,
  COMMANDS,
  formatShortcut,
  fuzzyScore,
  isCommandAvailable,
  type CommandAvailability,
  type CommandId,
  type CommandSpec,
} from "../lib/commands-registry";
import { useModalDialog } from "../lib/use-modal-dialog";

export function CommandPalette({
  open,
  availability,
  onClose,
  onRun,
}: {
  open: boolean;
  availability: CommandAvailability;
  onClose: () => void;
  onRun: (id: CommandId) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<CommandId | null>(null);

  useModalDialog({ open, onClose, dialogRef, initialFocusRef: inputRef });

  const results = useMemo(
    () =>
      COMMANDS.map((command) => ({ command, score: fuzzyScore(command, query) }))
        .filter(
          (result): result is { command: CommandSpec; score: number } =>
            result.score !== null,
        )
        .sort((a, b) => a.score - b.score),
    [query],
  );
  const enabledResults = results.filter(({ command }) =>
    isCommandAvailable(command.id, availability),
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
  }, [open]);

  useEffect(() => {
    if (!enabledResults.some(({ command }) => command.id === activeId)) {
      setActiveId(enabledResults[0]?.command.id ?? null);
    }
  }, [activeId, enabledResults]);

  if (!open) return null;

  function run(id: CommandId) {
    onClose();
    requestAnimationFrame(() => requestAnimationFrame(() => onRun(id)));
  }

  function moveActive(direction: 1 | -1) {
    if (enabledResults.length === 0) return;
    const current = enabledResults.findIndex(
      ({ command }) => command.id === activeId,
    );
    const next =
      (current + direction + enabledResults.length) % enabledResults.length;
    const id = enabledResults[next]!.command.id;
    setActiveId(id);
    document
      .getElementById(`${listboxId}-${id}`)
      ?.scrollIntoView({ block: "nearest" });
  }

  return (
    <div
      ref={dialogRef}
      className="overlay-in fixed inset-0 z-60 flex justify-center bg-scrim px-16 pt-[min(16vh,140px)] backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="dialog-in flex h-fit max-h-[min(620px,72vh)] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-[14px] border border-panel-hairline bg-panel shadow-[0_28px_90px_rgb(0_0_0/0.58)]">
        <label className="flex shrink-0 items-center gap-10 border-b border-panel-hairline px-14 py-12">
          <Search size={16} className="text-ink-dim" aria-hidden="true" />
          <span className="sr-only">Search commands</span>
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command…"
            role="combobox"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={
              activeId ? `${listboxId}-${activeId}` : undefined
            }
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === "Enter" && activeId) {
                event.preventDefault();
                run(activeId);
              }
            }}
          />
          <kbd>Esc</kbd>
        </label>

        <div
          id={listboxId}
          className="min-h-0 overflow-y-auto p-6"
          role="listbox"
        >
          {COMMAND_GROUPS.map((group) => {
            const groupResults = results.filter(
              ({ command }) => command.group === group,
            );
            if (groupResults.length === 0) return null;
            return (
              <section key={group} aria-label={group}>
                <h2 className="menu-heading m-0">{group}</h2>
                {groupResults.map(({ command }) => {
                  const enabled = isCommandAvailable(command.id, availability);
                  const active = enabled && command.id === activeId;
                  return (
                    <button
                      key={command.id}
                      id={`${listboxId}-${command.id}`}
                      type="button"
                      className={`command-palette-item menu-item ${active ? "active" : ""}`}
                      role="option"
                      aria-selected={active}
                      disabled={!enabled}
                      onMouseEnter={() => enabled && setActiveId(command.id)}
                      onClick={() => run(command.id)}
                    >
                      <span className="menu-label">{command.label}</span>
                      {command.shortcut && (
                        <kbd>{formatShortcut(command.shortcut)}</kbd>
                      )}
                    </button>
                  );
                })}
              </section>
            );
          })}
          {results.length === 0 && (
            <p className="m-0 px-10 py-24 text-center text-[12px] text-ink-dim">
              No matching commands
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

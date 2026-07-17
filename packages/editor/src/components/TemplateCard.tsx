import type { TemplateProposal } from "../lib/template-proposals";

export function TemplateCard({
  proposal,
  ready,
  busy,
  disabled,
  vibeLabel,
  actionLabel,
  onUse,
  onPalette,
  compact = false,
}: {
  proposal: TemplateProposal;
  ready: boolean;
  busy: boolean;
  disabled: boolean;
  vibeLabel: string;
  actionLabel: string;
  onUse(): void;
  onPalette(paletteId: string): void;
  compact?: boolean;
}) {
  return (
    <article className="group relative overflow-hidden rounded-panel border border-panel-hairline bg-panel text-left shadow-[0_8px_24px_rgb(19_16_25/0.07)] transition-[border-color,transform,box-shadow] duration-160 ease-studio hover:-translate-y-2 hover:border-accent/55 hover:shadow-[0_18px_40px_rgb(19_16_25/0.16)] focus-within:border-accent/55 motion-reduce:transform-none motion-reduce:transition-none">
      <button
        type="button"
        className="block w-full text-left active:scale-[0.99] disabled:cursor-wait motion-reduce:transform-none"
        onClick={onUse}
        disabled={disabled || !ready}
        aria-label={
          ready
            ? `${actionLabel}: ${proposal.archetypeLabel}`
            : `Loading fonts for ${proposal.archetypeLabel} template`
        }
      >
        <span
          className={`relative grid place-items-center overflow-hidden border-b border-panel-hairline bg-[radial-gradient(circle_at_50%_18%,var(--color-card),var(--color-field)_74%)] ${
            compact ? "aspect-[16/10]" : "aspect-[4/3]"
          }`}
        >
          {ready ? (
            <span
              className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center p-11 transition-transform duration-160 ease-studio group-hover:scale-[1.015] motion-reduce:transform-none motion-reduce:transition-none [&>svg]:block [&>svg]:h-auto [&>svg]:max-h-full [&>svg]:max-w-full [&>svg]:w-auto"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: proposal.svg }}
            />
          ) : (
            <span className="grid w-full gap-10 px-24" aria-hidden="true">
              <span className="mx-auto h-52 w-52 animate-pulse rounded-full bg-ink/8 motion-reduce:animate-none" />
              <span className="mx-auto h-10 w-3/5 animate-pulse rounded-full bg-ink/8 motion-reduce:animate-none" />
              <span className="mx-auto h-8 w-2/5 animate-pulse rounded-full bg-ink/6 motion-reduce:animate-none" />
            </span>
          )}
          {busy && (
            <span className="absolute inset-0 grid place-items-center bg-panel/78 text-[11px] font-semibold text-accent backdrop-blur-[1px]">
              Working…
            </span>
          )}
          <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.035),inset_0_-18px_36px_rgb(19_16_25/0.05)]" aria-hidden="true" />
        </span>
        <span className="flex items-center justify-between gap-8 px-12 py-10">
          <span>
            <strong className="block text-[12.5px] font-[650] text-ink">
              {proposal.archetypeLabel}
            </strong>
            <small className="mt-2 block text-[10px] capitalize text-ink-faint">
              {vibeLabel}
            </small>
          </span>
          <span className="max-w-[58%] translate-x-2 truncate rounded-full bg-accent/9 px-7 py-4 text-[9.5px] font-semibold text-accent opacity-0 transition-[opacity,transform] duration-140 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100 motion-reduce:transform-none motion-reduce:transition-none">
            {actionLabel}
          </span>
        </span>
      </button>

      <div
        className="absolute right-8 top-8 flex -translate-y-2 gap-5 rounded-full border border-white/55 bg-white/90 p-5 opacity-0 shadow-[0_6px_18px_rgb(19_16_25/0.2)] backdrop-blur-sm transition-[opacity,transform] duration-140 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 motion-reduce:transform-none motion-reduce:transition-none"
        role="group"
        aria-label={`Palette for ${proposal.archetypeLabel}`}
      >
        {proposal.paletteOptions.map((palette) => (
          <button
            key={palette.id}
            type="button"
            className={`h-18 w-18 rounded-full border-2 border-white transition-transform hover:scale-110 focus-visible:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45 motion-reduce:transform-none ${
              proposal.paletteId === palette.id
                ? "shadow-[0_0_0_2px_var(--color-accent),0_2px_8px_rgb(19_16_25/0.25)]"
                : "shadow-[0_0_0_1px_rgb(19_16_25/0.18)]"
            }`}
            style={{
              background: `linear-gradient(135deg, ${palette.ink} 0 50%, ${palette.accent} 50% 100%)`,
            }}
            aria-label={`Use ${palette.name} palette`}
            aria-pressed={proposal.paletteId === palette.id}
            title={palette.name}
            disabled={disabled}
            onClick={() => onPalette(palette.id)}
          />
        ))}
      </div>
    </article>
  );
}

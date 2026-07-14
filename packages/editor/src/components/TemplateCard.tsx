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
    <article className="group relative overflow-hidden rounded-panel border border-panel-hairline bg-panel text-left shadow-[0_8px_24px_rgb(19_16_25/0.07)] transition-[border-color,transform,box-shadow] duration-160 ease-studio hover:-translate-y-1 hover:border-accent/55 hover:shadow-[0_16px_36px_rgb(19_16_25/0.13)] focus-within:border-accent/55">
      <button
        type="button"
        className="block w-full text-left disabled:cursor-wait"
        onClick={onUse}
        disabled={disabled || !ready}
        aria-label={
          ready
            ? `${actionLabel}: ${proposal.archetypeLabel}`
            : `Loading fonts for ${proposal.archetypeLabel} template`
        }
      >
        <span
          className={`relative grid place-items-center overflow-hidden border-b border-panel-hairline bg-field/65 ${
            compact ? "aspect-[16/10]" : "aspect-[4/3]"
          }`}
        >
          {ready ? (
            <span
              className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center p-11 [&>svg]:block [&>svg]:h-auto [&>svg]:max-h-full [&>svg]:max-w-full [&>svg]:w-auto"
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
          <span className="text-[10px] font-semibold text-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {actionLabel}
          </span>
        </span>
      </button>

      <div
        className="absolute right-8 top-8 flex gap-5 rounded-full border border-white/55 bg-white/88 p-5 opacity-0 shadow-[0_4px_14px_rgb(19_16_25/0.18)] backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        role="group"
        aria-label={`Palette for ${proposal.archetypeLabel}`}
      >
        {proposal.paletteOptions.map((palette) => (
          <button
            key={palette.id}
            type="button"
            className="h-18 w-18 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(19_16_25/0.18)] transition-transform hover:scale-110 focus-visible:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45"
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

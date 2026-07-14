import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Vibe } from "@openlogo/foundry";
import { catalogEntry } from "./font-catalog";
import {
  ensurePreviewFace,
  isPreviewFaceReady,
  previewsSnapshot,
  subscribePreviews,
} from "./font-preview";
import {
  buildTemplateProposals,
  type TemplateProposal,
} from "./template-proposals";

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

export function templateFontsReady(proposal: TemplateProposal): boolean {
  return proposal.fonts.every((request) => {
    const family = catalogEntry(request.sourceFamily);
    return family
      ? isPreviewFaceReady(family, request.weight, request.style)
      : false;
  });
}

export function useTemplateGallery({
  initialBrandName,
  initialTagline = "",
  count,
}: {
  initialBrandName: string;
  initialTagline?: string;
  count: number;
}) {
  const [brandName, setBrandName] = useState(initialBrandName);
  const [tagline, setTagline] = useState(initialTagline);
  const [vibe, setVibe] = useState<Vibe | null>(null);
  const [shuffleRound, setShuffleRound] = useState(0);
  const [paletteOverrides, setPaletteOverrides] = useState<Record<string, string>>({});
  const debouncedBrand = useDebouncedValue(brandName, 180);
  const debouncedTagline = useDebouncedValue(tagline, 180);
  useSyncExternalStore(subscribePreviews, previewsSnapshot);

  const proposals = useMemo(
    () =>
      buildTemplateProposals({
        brandName: debouncedBrand,
        tagline: debouncedTagline,
        ...(vibe ? { vibe } : {}),
        shuffleRound,
        count,
        paletteOverrides,
      }),
    [count, debouncedBrand, debouncedTagline, paletteOverrides, shuffleRound, vibe],
  );

  useEffect(() => {
    const requested = new Set<string>();
    for (const proposal of proposals) {
      for (const request of proposal.fonts) {
        const family = catalogEntry(request.sourceFamily);
        const key = `${request.sourceFamily}:${request.weight}:${request.style}`;
        if (family && !requested.has(key)) {
          requested.add(key);
          void ensurePreviewFace(family, request.weight, request.style);
        }
      }
    }
  }, [proposals]);

  return {
    brandName,
    setBrandName,
    tagline,
    setTagline,
    vibe,
    setVibe: (next: Vibe | null) => {
      setVibe(next);
      setPaletteOverrides({});
    },
    shuffle: () => {
      setShuffleRound((round) => round + 1);
      setPaletteOverrides({});
    },
    proposals,
    readyCount: proposals.filter(templateFontsReady).length,
    setPalette: (key: string, paletteId: string) =>
      setPaletteOverrides((current) => ({ ...current, [key]: paletteId })),
    previewBrandName: debouncedBrand || "your brand",
  };
}

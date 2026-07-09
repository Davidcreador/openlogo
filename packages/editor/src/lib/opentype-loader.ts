import { Data, Effect } from "effect";
import type opentype from "opentype.js";

/** opentype.js module load failure (dynamic import rejected). */
export class OpentypeLoadError extends Data.TaggedError("OpentypeLoadError")<{
  readonly cause: unknown;
}> {}

/**
 * opentype.js is heavy, so it loads lazily on first use and the module
 * stays memoized (`Effect.cached`). Shared by text-to-path (outlines)
 * and font-store (kern/GPOS pair extraction). A module import has no
 * release side, so this is a cache, not an acquireRelease scope.
 */
export const opentypeModule: Effect.Effect<typeof opentype, OpentypeLoadError> =
  Effect.runSync(
    Effect.cached(
      Effect.tryPromise({
        try: () => import("opentype.js").then((module) => module.default),
        catch: (cause) => new OpentypeLoadError({ cause }),
      }),
    ),
  );

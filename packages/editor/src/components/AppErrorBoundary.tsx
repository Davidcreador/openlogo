import { Component, type ErrorInfo, type ReactNode } from "react";
import { Download, RefreshCcw, ShieldAlert } from "lucide-react";
import { saveDocumentFile } from "../lib/document-file";

type AppErrorBoundaryProps = {
  readonly children: ReactNode;
};

type AppErrorBoundaryState = {
  readonly error: Error | null;
  readonly recoveryDownloadFailed: boolean;
};

/**
 * Last-resort product shell for uncaught React failures. The live document
 * store remains in memory, so users can download it before reloading instead
 * of being stranded behind a blank screen.
 */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
    recoveryDownloadFailed: false,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, recoveryDownloadFailed: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("OpenLogo UI crashed", error, info.componentStack);
  }

  private downloadRecovery = (): void => {
    try {
      saveDocumentFile();
      this.setState({ recoveryDownloadFailed: false });
    } catch (error) {
      console.error("Recovery download failed", error);
      this.setState({ recoveryDownloadFailed: true });
    }
  };

  render(): ReactNode {
    const { error, recoveryDownloadFailed } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <main
        className="grid min-h-screen place-items-center bg-surface p-24 text-ink"
        aria-labelledby="app-crash-title"
      >
        <section className="w-full max-w-[560px] rounded-panel border border-panel-border bg-panel p-28 shadow-panel">
          <div className="mb-20 flex h-44 w-44 items-center justify-center rounded-[12px] bg-[color-mix(in_srgb,var(--color-danger)_12%,white)] text-danger">
            <ShieldAlert aria-hidden="true" size={22} />
          </div>
          <p className="mb-8 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-dim">
            Recovery mode
          </p>
          <h1 id="app-crash-title" className="m-0 text-[24px] leading-[1.2]">
            The editor hit an unexpected error.
          </h1>
          <p className="mb-0 mt-12 max-w-[48ch] text-[13px] leading-[1.55] text-ink-dim">
            Your current work may still be available in memory and local
            recovery. Download a copy before reloading the editor.
          </p>

          <div className="mt-24 flex flex-wrap gap-8">
            <button
              type="button"
              className="inline-flex min-h-36 items-center gap-8 rounded-field bg-accent px-14 font-semibold text-white hover:bg-accent-deep focus-visible:outline-none focus-visible:shadow-ring"
              onClick={this.downloadRecovery}
            >
              <Download aria-hidden="true" size={15} />
              Download recovery copy
            </button>
            <button
              type="button"
              className="inline-flex min-h-36 items-center gap-8 rounded-field border border-panel-border bg-card px-14 font-semibold hover:bg-field focus-visible:outline-none focus-visible:shadow-ring"
              onClick={() => window.location.reload()}
            >
              <RefreshCcw aria-hidden="true" size={15} />
              Reload editor
            </button>
          </div>

          {recoveryDownloadFailed ? (
            <p role="alert" className="mb-0 mt-12 text-[12px] text-danger">
              The recovery copy could not be downloaded. Reloading may still
              restore the latest local version.
            </p>
          ) : null}

          <details className="mt-20 border-t border-panel-border pt-16 text-[11px] text-ink-dim">
            <summary className="cursor-pointer font-semibold text-ink">
              Technical details
            </summary>
            <p className="mb-0 mt-8 break-words font-mono leading-[1.5]">
              {error.message || error.name}
            </p>
          </details>
        </section>
      </main>
    );
  }
}

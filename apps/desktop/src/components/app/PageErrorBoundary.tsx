import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

type Props = {
  /** The page's name, as the sidebar shows it. */
  page: string;
  children: ReactNode;
};

type State = { error: Error | null };

/**
 * Keeps a fault in one page inside that page. Without it, an error while drawing any page blanked the whole window,
 * sidebar and overlay controls included, until the app was restarted. The sidebar, the readiness light, the runtime
 * switch and the miss buttons stay usable, and the page can be tried again or the window reloaded. App.tsx keys it by
 * page, so moving to another page always starts clean.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console for a bug report; the page itself says what to do.
    console.error(`The ${this.props.page} page failed:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A page's code that cannot be loaded (after the app was rebuilt underneath it) needs a reload, not a retry.
    const stale = /dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(error.message);
    return (
      <main className="shell" role="alert" aria-live="assertive">
        <Alert variant="destructive">
          <AlertTitle>{this.props.page} hit an error</AlertTitle>
          <AlertDescription>
            <p>
              {stale
                ? "This page's code changed since the app opened. Reload the window to load it again."
                : "The rest of the app keeps working: the models, recipes and the volume knob are not affected. Try the page again, or reload the window."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {!stale && <Button type="button" onClick={() => this.setState({ error: null })}>Try again</Button>}
              <Button type="button" variant="outline" onClick={() => window.location.reload()}>Reload the window</Button>
            </div>
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer">What went wrong</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words">{error.message}</pre>
            </details>
          </AlertDescription>
        </Alert>
      </main>
    );
  }
}

import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Without this, any uncaught render-time exception anywhere in the tree unmounts the whole app to
// a blank white page with nothing in the UI to explain why — the only trace is a console error the
// user can't easily hand back to us. Showing the message/stack directly (not a generic "something
// went wrong") turns an unreproducible bug report into an actionable one.
//
// This project has no @types/react installed, so the `react` import resolves to `any` — and
// TypeScript specially collapses an `any`-typed base class's inherited members to `{}` rather than
// `any`, meaning `props`/`state`/`setState` aren't visible unless redeclared here with `declare`
// (type-only, no runtime effect — the real implementation still comes from Component at runtime).
export class ErrorBoundary extends Component<Props, State> {
  declare props: Props;
  declare state: State;
  declare setState: (state: Partial<State>) => void;

  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-surface flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-white rounded-2xl border border-border-subtle p-5 space-y-3">
            <p className="text-lg font-black text-error">Something went wrong</p>
            <p className="text-sm text-text-muted">
              Please screenshot this and send it back — it'll help track down the bug. Reloading usually recovers.
            </p>
            <pre className="text-[11px] bg-surface rounded-xl p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words">
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
            </pre>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              className="w-full py-3 bg-primary text-white font-bold rounded-2xl"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

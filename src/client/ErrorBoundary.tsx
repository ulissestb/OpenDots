import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Last-resort fallback so a render error never leaves a blank page. */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('OpenDots crashed while rendering', error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="unlock" role="alert">
        <h1>Something went wrong.</h1>
        <p>
          The page hit an unexpected error. Saved work is on the server; reload
          to continue.
        </p>
        <button className="primary" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}

// Shown while a page's data is loading, or if it failed to load.

import { LoaderCircle } from "lucide-react";

export default function LoadState({ loading, error, onRetry }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-dim">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
        Loading
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
      {error}
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-3 underline underline-offset-2">
          Try again
        </button>
      )}
    </div>
  );
}
import { DocumentTitle } from '../components/document-title.js';

/** Minimal foundation placeholder — not a product dashboard. */
export function FoundationHomePage() {
  return (
    <DocumentTitle title="Roomies">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
          Roomies
        </h1>
        <p className="max-w-prose text-base text-text-secondary">
          Frontend foundation is ready. Product screens will land here later.
        </p>
      </div>
    </DocumentTitle>
  );
}

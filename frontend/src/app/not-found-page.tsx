import { Link } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';

/** User-facing not-found page (no internal route/debug details). */
export function NotFoundPage() {
  return (
    <DocumentTitle title="Page not found · Roomies">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Page not found
        </h1>
        <p className="max-w-prose text-base text-text-secondary">
          That page does not exist or is no longer available.
        </p>
        <p>
          <Link
            to="/"
            className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Back to Roomies
          </Link>
        </p>
      </div>
    </DocumentTitle>
  );
}

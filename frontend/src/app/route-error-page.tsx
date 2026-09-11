import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { PageContainer } from '../components/page-container.js';

/**
 * Safe top-level recovery UI for route/render failures.
 * Never shows stack traces or raw exception details to users.
 */
export function RouteErrorPage() {
  const error = useRouteError();

  // Keep a development breadcrumb in the console only.
  if (import.meta.env.DEV) {
    console.error(error);
  }

  const heading = isRouteErrorResponse(error)
    ? error.status === 404
      ? 'Page not found'
      : 'Something went wrong'
    : 'Something went wrong';

  const message =
    isRouteErrorResponse(error) && error.status === 404
      ? 'That page does not exist or is no longer available.'
      : 'An unexpected error occurred. Please try again.';

  return (
    <DocumentTitle title={`${heading} · Roomies`}>
      <div className="flex min-h-dvh flex-col bg-bg text-text-primary">
        <header className="border-b border-border bg-surface">
          <PageContainer className="flex h-14 items-center sm:h-16">
            <p className="text-lg font-semibold tracking-tight">Roomies</p>
          </PageContainer>
        </header>
        <main className="flex-1 py-6 sm:py-8">
          <PageContainer>
            <div className="flex flex-col gap-4">
              <h1 className="text-2xl font-semibold tracking-tight">
                {heading}
              </h1>
              <p className="max-w-prose text-base text-text-secondary">
                {message}
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
          </PageContainer>
        </main>
      </div>
    </DocumentTitle>
  );
}

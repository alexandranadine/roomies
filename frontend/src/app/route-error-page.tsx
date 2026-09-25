import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AuthPageLayout } from '../auth/auth-page-layout.js';

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
    <div className="flex min-h-dvh flex-col bg-bg text-text-primary">
      <AuthPageLayout title={`${heading} · Roomies`}>
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            {heading}
          </h1>
          <p className="max-w-prose text-base text-text-secondary">{message}</p>
          <p>
            <Link
              to="/"
              className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
            >
              Back to Roomies
            </Link>
          </p>
        </div>
      </AuthPageLayout>
    </div>
  );
}

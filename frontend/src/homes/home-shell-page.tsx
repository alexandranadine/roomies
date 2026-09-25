import { Link, Outlet, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { PageContainer } from '../components/page-container.js';
import { HomeChromeLayout } from './home-chrome-layout.js';
import { HomeShellFallbackHeader } from './home-shell-header.js';

const HOME_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * URL-backed Home shell. Query data is keyed by homeId so a previous Home
 * cannot render as the current one while the next context loads.
 */
export function HomeShellPage() {
  const { homeId = '' } = useParams();
  const validHomeId = HOME_ID_PATTERN.test(homeId);

  if (!validHomeId) {
    return (
      <DocumentTitle title="Home unavailable · Roomies">
        <HomeShellFallbackHeader to="/" />
        <PageContainer>
          <div className="flex flex-col gap-4 py-6">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              This Home isn’t available
            </h1>
            <p className="max-w-prose text-base text-text-secondary">
              It may not exist, or you may not be able to open it right now.
            </p>
            <p>
              <Link
                to="/"
                className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
              >
                Back to your Homes
              </Link>
            </p>
          </div>
        </PageContainer>
      </DocumentTitle>
    );
  }

  return (
    <HomeChromeLayout homeId={homeId}>
      {(context) => <Outlet context={context} />}
    </HomeChromeLayout>
  );
}

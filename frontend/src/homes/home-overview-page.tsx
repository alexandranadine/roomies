import { Link, useOutletContext } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import type { HomeContext } from './home-context-api.js';

export type HomeShellOutletContext = {
  home: HomeContext;
};

export function HomeOverviewPage() {
  const { home } = useOutletContext<HomeShellOutletContext>();

  return (
    <DocumentTitle title={`${home.name} · Roomies`}>
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
          {home.name}
        </h1>
        <p className="max-w-prose text-base text-text-secondary">
          Shared life for this Home. Use Maintenance for household upkeep items
          that need attention.
        </p>
        <p>
          <Link
            to={`/homes/${encodeURIComponent(home.id)}/maintenance`}
            className="font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            Open Maintenance
          </Link>
        </p>
      </div>
    </DocumentTitle>
  );
}

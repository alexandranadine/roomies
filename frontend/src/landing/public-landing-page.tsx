import {
  BellIcon,
  ClipboardDocumentCheckIcon,
  QueueListIcon,
  UserGroupIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import type { ComponentType, SVGProps } from 'react';
import { Link } from 'react-router';
import { SIGN_IN_HREF, SIGN_UP_HREF } from '../auth/auth-entry.js';
import { DocumentTitle } from '../components/document-title.js';
import { RoomiesWordmark } from '../components/roomies-wordmark.js';
import { Card } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import {
  LANDING_ALPHA_BODY,
  LANDING_ALPHA_TITLE,
  LANDING_COMING_HEADING,
  LANDING_COMING_ITEMS,
  LANDING_CREATE_ACCOUNT,
  LANDING_FEATURES,
  LANDING_FEATURES_HEADING,
  LANDING_HEADLINE,
  LANDING_SIGN_IN,
  LANDING_SUPPORTING,
} from './landing-copy.js';

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

const FEATURE_ICONS: Record<(typeof LANDING_FEATURES)[number]['title'], HeroIcon> =
  {
    Tasks: ClipboardDocumentCheckIcon,
    'Roommates & invites': UserGroupIcon,
    Maintenance: WrenchScrewdriverIcon,
    Notifications: BellIcon,
    'Home activity': QueueListIcon,
  };

const ctaBaseClassName = cn(
  'inline-flex min-h-control-lg items-center justify-center gap-2 rounded-lg border px-4 text-center text-sm font-semibold no-underline',
  'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
);

const primaryCtaClassName = cn(
  ctaBaseClassName,
  'border-brand bg-brand text-white hover:bg-brand-hover hover:text-white hover:no-underline active:bg-brand-active',
);

const secondaryCtaClassName = cn(
  ctaBaseClassName,
  'border-border-strong bg-surface text-text-primary hover:bg-subtle hover:text-text-primary hover:no-underline active:bg-border/60',
);

/**
 * Closed-alpha public landing. Auth stays on the existing CredentialForm
 * via `/?auth=sign-in` and `/?auth=sign-up`.
 */
export function PublicLandingPage() {
  const featuresHeadingId = 'landing-features-heading';
  const alphaHeadingId = 'landing-alpha-heading';
  const comingHeadingId = 'landing-coming-heading';

  return (
    <DocumentTitle title="Roomies">
      <div className="flex flex-1 flex-col px-4 py-8 sm:py-10">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
          <div className="flex flex-col gap-5">
            <RoomiesWordmark />
            <div className="flex flex-col gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-text-primary lg:text-2xl">
                {LANDING_HEADLINE}
              </h1>
              <p className="text-sm text-text-secondary">{LANDING_SUPPORTING}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link
                to={SIGN_UP_HREF}
                className={cn(primaryCtaClassName, 'w-full sm:flex-1')}
              >
                {LANDING_CREATE_ACCOUNT}
              </Link>
              <Link
                to={SIGN_IN_HREF}
                className={cn(secondaryCtaClassName, 'w-full sm:flex-1')}
              >
                {LANDING_SIGN_IN}
              </Link>
            </div>
          </div>

          <section
            aria-labelledby={alphaHeadingId}
            className="rounded-xl border border-brand/20 bg-brand-soft px-4 py-3 shadow-card"
          >
            <h2
              id={alphaHeadingId}
              className="text-sm font-semibold text-brand-soft-text"
            >
              {LANDING_ALPHA_TITLE}
            </h2>
            <p className="mt-1 text-sm text-brand-soft-text">
              {LANDING_ALPHA_BODY}
            </p>
          </section>

          <section aria-labelledby={featuresHeadingId}>
            <h2
              id={featuresHeadingId}
              className="mb-3 text-sm font-semibold text-text-primary"
            >
              {LANDING_FEATURES_HEADING}
            </h2>
            <Card padding="md">
              <ul className="flex flex-col gap-4">
                {LANDING_FEATURES.map((feature) => {
                  const Icon = FEATURE_ICONS[feature.title];
                  return (
                    <li key={feature.title} className="flex gap-3">
                      <span
                        className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"
                        aria-hidden="true"
                      >
                        <Icon className="size-5" />
                      </span>
                        <div className="flex min-w-0 flex-col gap-0.5">
                        <h3 className="text-sm font-semibold text-text-primary">
                          {feature.title}
                        </h3>
                        <p className="text-sm text-text-secondary">
                          {feature.body}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </section>

          <section aria-labelledby={comingHeadingId}>
            <h2
              id={comingHeadingId}
              className="text-sm font-semibold text-text-secondary"
            >
              {LANDING_COMING_HEADING}
            </h2>
            <ul className="mt-2 flex flex-col gap-1">
              {LANDING_COMING_ITEMS.map((item) => (
                <li key={item} className="text-sm text-text-muted">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </DocumentTitle>
  );
}

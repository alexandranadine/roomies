import { Activity, ChevronRight, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '../components/ui/cn.js';
import type { HousePulseDto } from './pulse-api.js';
import type { PulseMetric } from './pulse-copy.js';
import { barPulseMetrics, glancePulseMetrics } from './pulse-copy.js';

export type HousePulseSectionProps = {
  homeId: string;
  pulse: HousePulseDto;
};

function PulseMetricItem({
  metric,
  className,
  leading,
}: {
  metric: PulseMetric;
  className?: string;
  leading?: boolean;
}) {
  return (
    <li className={cn('flex min-w-0 items-baseline gap-1', className)}>
      {leading ? null : (
        <span className="text-text-muted" aria-hidden="true">
          ·
        </span>
      )}
      <p className="text-sm font-bold leading-none text-text-primary">
        {metric.value}
      </p>
      <p className="text-xs font-medium text-text-secondary">{metric.label}</p>
    </li>
  );
}

const actionLinkClassName = cn(
  'inline-flex size-8 items-center justify-center rounded-md text-text-muted',
  'hover:bg-subtle hover:text-brand',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
);

/**
 * Household status glance. Renders backend Pulse metrics without
 * recomputing state or inventing unavailable counts.
 */
export function HousePulseSection({ homeId, pulse }: HousePulseSectionProps) {
  const glance = glancePulseMetrics(pulse);
  const extras = barPulseMetrics(pulse);
  const tasksHref = `/homes/${encodeURIComponent(homeId)}/tasks`;
  const maintenanceHref = `/homes/${encodeURIComponent(homeId)}/maintenance`;

  const actions = (
    <span className="flex shrink-0 items-center">
      <Link
        to={maintenanceHref}
        aria-label="Open Maintenance"
        className={actionLinkClassName}
      >
        <Wrench className="size-4" aria-hidden="true" />
      </Link>
      <Link
        to={tasksHref}
        aria-label="Open Tasks"
        className={actionLinkClassName}
      >
        <ChevronRight className="size-5" aria-hidden="true" />
      </Link>
    </span>
  );

  return (
    <section aria-labelledby="house-pulse-heading" data-testid="house-pulse">
      <div
        className={cn(
          'rounded-xl border border-border bg-surface p-3 shadow-card',
          'lg:border-border/80 lg:bg-subtle/50 lg:px-3.5 lg:py-2 lg:shadow-none',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 lg:flex-nowrap lg:gap-3">
          <span
            className="order-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"
            aria-hidden="true"
          >
            <Activity className="size-4" />
          </span>
          <h2
            id="house-pulse-heading"
            className="order-2 shrink-0 text-sm font-semibold tracking-tight text-text-primary"
          >
            House Pulse
          </h2>
          <span className="order-3 ml-auto lg:order-4 lg:ml-0">{actions}</span>
          <ul className="order-4 mt-0.5 flex w-full min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 lg:order-3 lg:mt-0 lg:w-auto lg:flex-1">
            {glance.map((metric, index) => (
              <PulseMetricItem
                key={metric.label}
                metric={metric}
                leading={index === 0}
                className="flex"
              />
            ))}
            {extras.map((metric) => (
              <PulseMetricItem
                key={metric.label}
                metric={metric}
                className="hidden lg:flex"
              />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

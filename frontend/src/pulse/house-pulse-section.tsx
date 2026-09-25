import { Activity, ChevronRight, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import { Card } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import type { HousePulseDto } from './pulse-api.js';
import type { PulseMetric } from './pulse-copy.js';
import { glancePulseMetrics, supportingPulseMetrics } from './pulse-copy.js';

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
    <li
      className={cn(
        'min-w-0 items-baseline gap-1.5 lg:w-full lg:justify-between',
        className,
      )}
    >
      {leading ? null : (
        <span className="text-text-muted lg:hidden" aria-hidden="true">
          ·
        </span>
      )}
      <p className="text-sm font-bold leading-none text-text-primary lg:order-2 lg:text-base">
        {metric.value}
      </p>
      <p className="text-xs font-medium text-text-secondary lg:order-1 lg:text-sm">
        {metric.label}
      </p>
    </li>
  );
}

/**
 * Household status glance. Renders backend Pulse metrics without
 * recomputing state or inventing unavailable counts.
 */
export function HousePulseSection({ homeId, pulse }: HousePulseSectionProps) {
  const glance = glancePulseMetrics(pulse);
  const supporting = supportingPulseMetrics(pulse);
  const tasksHref = `/homes/${encodeURIComponent(homeId)}/tasks`;
  const maintenanceHref = `/homes/${encodeURIComponent(homeId)}/maintenance`;

  return (
    <section aria-labelledby="house-pulse-heading" data-testid="house-pulse">
      <Card className="p-3">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"
            aria-hidden="true"
          >
            <Activity className="size-4" />
          </span>
          <h2
            id="house-pulse-heading"
            className="min-w-0 flex-1 text-sm font-semibold tracking-tight text-text-primary"
          >
            House Pulse
          </h2>
          <p className="flex shrink-0 items-center">
            <Link
              to={maintenanceHref}
              aria-label="Open Maintenance"
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-md text-text-muted',
                'hover:bg-subtle hover:text-brand',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              )}
            >
              <Wrench className="size-4" aria-hidden="true" />
            </Link>
            <Link
              to={tasksHref}
              aria-label="Open Tasks"
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-md text-text-muted',
                'hover:bg-subtle hover:text-brand',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              )}
            >
              <ChevronRight className="size-5" aria-hidden="true" />
            </Link>
          </p>
        </div>

        <ul className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 lg:mt-3 lg:flex-col lg:items-stretch lg:gap-2">
          {glance.map((metric, index) => (
            <PulseMetricItem
              key={metric.label}
              metric={metric}
              leading={index === 0}
              className="flex"
            />
          ))}
          {supporting.map((metric) => (
            <PulseMetricItem
              key={metric.label}
              metric={metric}
              leading
              className="hidden lg:flex"
            />
          ))}
        </ul>
      </Card>
    </section>
  );
}

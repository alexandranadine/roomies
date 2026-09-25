import { CheckSquare, Package, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import { Card } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import type { HousePulseDto } from './pulse-api.js';
import {
  compactPulseMetrics,
  pulseOverallState,
  pulseStateLabel,
} from './pulse-copy.js';

export type HousePulseSectionProps = {
  homeId: string;
  pulse: HousePulseDto;
};

/**
 * Compact current-state summary. Renders backend Pulse metrics without
 * recomputing state or inventing unavailable counts.
 */
export function HousePulseSection({ homeId, pulse }: HousePulseSectionProps) {
  const metrics = compactPulseMetrics(pulse);
  const overall = pulseOverallState(pulse);
  const tasksHref = `/homes/${encodeURIComponent(homeId)}/tasks`;
  const maintenanceHref = `/homes/${encodeURIComponent(homeId)}/maintenance`;

  return (
    <section
      aria-labelledby="house-pulse-heading"
      className="flex flex-col gap-2"
      data-testid="house-pulse"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h2
          id="house-pulse-heading"
          className="text-base font-semibold tracking-tight text-text-primary"
        >
          House Pulse
        </h2>
        <p
          className="text-xs font-medium text-text-secondary"
          data-pulse-state={overall}
        >
          {pulseStateLabel(overall)}
        </p>
      </header>

      <Card className="p-3 sm:p-4">
        <ul className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          {metrics.map((metric, index) => {
            const Icon =
              index < 4 ? CheckSquare : index === 4 ? Package : Wrench;
            return (
              <li
                key={metric.label}
                className="flex min-w-0 items-baseline gap-1.5"
              >
                <Icon
                  className="relative top-px size-3.5 shrink-0 text-brand"
                  aria-hidden="true"
                />
                <p className="text-base font-bold leading-none text-text-primary">
                  {metric.value}
                </p>
                <p className="text-xs font-medium text-text-secondary">
                  {metric.label}
                </p>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          <Link
            to={tasksHref}
            className={cn(
              'inline-flex min-h-8 items-center text-sm font-medium text-brand',
              'underline-offset-4 hover:text-brand-hover hover:underline',
              'focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            )}
          >
            Open Tasks
          </Link>
          <Link
            to={maintenanceHref}
            className={cn(
              'inline-flex min-h-8 items-center text-sm font-medium text-brand',
              'underline-offset-4 hover:text-brand-hover hover:underline',
              'focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            )}
          >
            Open Maintenance
          </Link>
        </p>
      </Card>
    </section>
  );
}
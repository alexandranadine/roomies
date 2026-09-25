import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge, Card } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import type {
  HousePulseDto,
  HousePulseSectionState,
  MaintenancePulseItem,
  SupplyPulseItem,
  TaskPulseItem,
} from './pulse-api.js';
import {
  maintenanceActiveCopy,
  maintenanceClearCopy,
  pulseStateLabel,
  suppliesActiveMetrics,
  suppliesClearCopy,
  tasksActiveMetrics,
  tasksClearCopy,
  type PulseMetric,
} from './pulse-copy.js';

function MetricsList({ metrics }: { metrics: readonly PulseMetric[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-secondary">
      {metrics.map((metric) => (
        <li key={metric.label}>{`${metric.label}: ${metric.value}`}</li>
      ))}
    </ul>
  );
}

function StateBadge({ state }: { state: HousePulseSectionState }) {
  return (
    <Badge
      variant={state === 'CLEAR' ? 'neutral' : 'brand'}
      data-pulse-state={state}
    >
      {pulseStateLabel(state)}
    </Badge>
  );
}

function SectionShell({
  title,
  state,
  children,
  footer,
}: {
  title: string;
  state: HousePulseSectionState;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <li className="border-t border-border px-3 py-3 first:border-t-0 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <StateBadge state={state} />
      </div>
      <div className="mt-1">{children}</div>
      {footer}
    </li>
  );
}

function TasksSection({
  item,
  homeId,
}: {
  item: TaskPulseItem;
  homeId: string;
}) {
  return (
    <SectionShell
      title="Tasks"
      state={item.state}
      footer={
        <p className="mt-2">
          <Link
            to={`/homes/${encodeURIComponent(homeId)}/tasks`}
            className={cn(
              'inline-flex min-h-control-lg items-center text-sm font-medium text-brand',
              'underline-offset-4 hover:text-brand-hover hover:underline',
              'focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            )}
          >
            Open Tasks
          </Link>
        </p>
      }
    >
      {item.state === 'CLEAR' ? (
        <p className="text-sm text-text-secondary">{tasksClearCopy()}</p>
      ) : (
        <MetricsList metrics={tasksActiveMetrics(item)} />
      )}
    </SectionShell>
  );
}

function SuppliesSection({ item }: { item: SupplyPulseItem }) {
  return (
    <SectionShell title="Supplies" state={item.state}>
      {item.state === 'CLEAR' ? (
        <p className="text-sm text-text-secondary">{suppliesClearCopy()}</p>
      ) : (
        <MetricsList metrics={suppliesActiveMetrics(item)} />
      )}
    </SectionShell>
  );
}

function MaintenanceSection({
  item,
  homeId,
}: {
  item: MaintenancePulseItem;
  homeId: string;
}) {
  return (
    <SectionShell
      title="Maintenance"
      state={item.state}
      footer={
        <p className="mt-2">
          <Link
            to={`/homes/${encodeURIComponent(homeId)}/maintenance`}
            className={cn(
              'inline-flex min-h-control-lg items-center text-sm font-medium text-brand',
              'underline-offset-4 hover:text-brand-hover hover:underline',
              'focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            )}
          >
            Open Maintenance
          </Link>
        </p>
      }
    >
      {item.state === 'CLEAR' ? (
        <p className="text-sm text-text-secondary">{maintenanceClearCopy()}</p>
      ) : (
        <p className="text-sm text-text-secondary">
          {maintenanceActiveCopy(item)}
        </p>
      )}
    </SectionShell>
  );
}

export type HousePulseSectionProps = {
  homeId: string;
  pulse: HousePulseDto;
};

/**
 * Compact current-state summary. Renders fixed Tasks → Supplies → Maintenance
 * order from the backend DTO without recomputing state or reordering.
 */
export function HousePulseSection({ homeId, pulse }: HousePulseSectionProps) {
  const [tasks, supplies, maintenance] = pulse.items;

  return (
    <section
      aria-labelledby="house-pulse-heading"
      className="flex flex-col gap-2"
      data-testid="house-pulse"
    >
      <header className="flex flex-col gap-0.5">
        <h2
          id="house-pulse-heading"
          className="text-lg font-semibold tracking-tight text-text-primary"
        >
          House Pulse
        </h2>
        <p className="text-sm text-text-secondary">
          Current snapshot for this Home.
        </p>
      </header>

      <Card className="p-0">
        <ul className="list-none">
          <TasksSection item={tasks} homeId={homeId} />
          <SuppliesSection item={supplies} />
          <MaintenanceSection item={maintenance} homeId={homeId} />
        </ul>
      </Card>
    </section>
  );
}

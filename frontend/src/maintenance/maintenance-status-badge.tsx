import { Badge } from '../components/ui/index.js';
import type { MaintenanceStatus } from './maintenance-api.js';
import { formatMaintenanceStatus } from './maintenance-format.js';

export function MaintenanceStatusBadge({
  status,
}: {
  status: MaintenanceStatus;
}) {
  return (
    <Badge variant={status === 'RESOLVED' ? 'success' : 'neutral'}>
      {formatMaintenanceStatus(status)}
    </Badge>
  );
}

import { useEffect, useId } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import {
  Alert,
  Button,
  Dialog,
  Radio,
  RadioGroup,
  Skeleton,
  TextField,
} from '../components/ui/index.js';
import { useHomeMemberships } from '../homes/use-home-memberships.js';
import { ApiError } from '../platform/api/index.js';
import {
  createTaskFormResolver,
  toCreateTaskRequest,
  type CreateTaskFormValues,
} from './create-task-form-schema.js';
import { SelectField } from './select-field.js';
import { assigneePickerLabel, UNASSIGNED_LABEL } from './task-assignee.js';
import {
  dayOfMonthInTimeZone,
  formatDayOfMonth,
  isoWeekdayInTimeZone,
} from './task-format.js';
import { useCreateTask } from './use-create-task.js';
import { useCreateTaskDefinition } from './use-create-task-definition.js';

const CREATE_FORM_ERROR =
  'Couldn’t add this task. Check the details and try again.';
const CREATE_UNAVAILABLE_ERROR =
  'This Home isn’t available right now. Try again later.';

const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
] as const;

function isConcealedScope(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

export type CreateTaskDialogProps = {
  homeId: string;
  timeZone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function emptyValues(timeZone: string): CreateTaskFormValues {
  return {
    title: '',
    assignedMembershipId: '',
    scheduledFor: '',
    repeat: 'ONCE',
    weekday: isoWeekdayInTimeZone(timeZone),
    dayOfMonth: dayOfMonthInTimeZone(timeZone),
  };
}

export function CreateTaskDialog({
  homeId,
  timeZone,
  open,
  onOpenChange,
}: CreateTaskDialogProps) {
  const formId = useId();
  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<CreateTaskFormValues>({
    resolver: createTaskFormResolver(),
    defaultValues: emptyValues(timeZone),
  });

  const repeat = useWatch({ control, name: 'repeat' });

  const membershipsQuery = useHomeMemberships({
    homeId,
    enabled: open && homeId.length > 0,
  });

  const createTaskMutation = useCreateTask();
  const createDefinitionMutation = useCreateTaskDefinition();

  useEffect(() => {
    reset(emptyValues(timeZone));
  }, [open, homeId, timeZone, reset]);

  const membershipsUnavailable =
    membershipsQuery.isError && isConcealedScope(membershipsQuery.error);
  const currentMembershipId = membershipsQuery.data?.currentMembershipId ?? '';
  const memberships = membershipsQuery.data?.memberships ?? [];

  const isPending =
    createTaskMutation.isPending || createDefinitionMutation.isPending;

  const submitCreate = handleSubmit(async (values) => {
    clearErrors('root');
    createTaskMutation.reset();
    createDefinitionMutation.reset();

    if (membershipsUnavailable) {
      setError('root', {
        type: 'server',
        message: CREATE_UNAVAILABLE_ERROR,
      });
      return;
    }

    const request = toCreateTaskRequest(values);

    try {
      if (request.kind === 'task') {
        await createTaskMutation.mutateAsync({
          homeId,
          body: request.body,
        });
      } else {
        await createDefinitionMutation.mutateAsync({
          homeId,
          body: request.body,
        });
      }
      onOpenChange(false);
    } catch (error) {
      if (isConcealedScope(error)) {
        void membershipsQuery.refetch();
        setError('root', {
          type: 'server',
          message: CREATE_UNAVAILABLE_ERROR,
        });
        return;
      }
      setError('root', { type: 'server', message: CREATE_FORM_ERROR });
    }
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Popup
        title="Add task"
        description="Something the house needs to get done."
        closeLabel="Close add task"
        className="max-h-[min(100dvh-2rem,44rem)]"
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => void submitCreate(event)}
          noValidate
        >
          <TextField
            label="Title"
            required
            autoComplete="off"
            disabled={isPending}
            invalid={Boolean(errors.title)}
            errorText={errors.title?.message}
            {...register('title')}
          />

          <Controller
            control={control}
            name="assignedMembershipId"
            render={({ field }) => (
              <SelectField
                label="Assigned to"
                value={field.value}
                disabled={
                  isPending ||
                  membershipsUnavailable ||
                  (membershipsQuery.isPending &&
                    membershipsQuery.data === undefined)
                }
                onChange={(event) => {
                  field.onChange(event.target.value);
                }}
                helperText="Optional. Anyone in the Home can still mark it done."
              >
                <option value="">{UNASSIGNED_LABEL}</option>
                {memberships.map((row) => (
                  <option key={row.membershipId} value={row.membershipId}>
                    {assigneePickerLabel(row, currentMembershipId)}
                  </option>
                ))}
              </SelectField>
            )}
          />

          {membershipsQuery.isPending &&
          membershipsQuery.data === undefined &&
          !membershipsUnavailable ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <Skeleton className="h-11 w-full" announced />
            </div>
          ) : null}

          {membershipsQuery.isError &&
          !membershipsUnavailable &&
          !membershipsQuery.isPending ? (
            <Alert variant="danger" title="Couldn’t load roommates">
              <p className="mb-3">Something went wrong. Try again.</p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void membershipsQuery.refetch();
                }}
              >
                Retry
              </Button>
            </Alert>
          ) : null}

          {membershipsUnavailable ? (
            <Alert variant="danger" title="Home unavailable">
              It may not exist, or you may not be able to open it right now.
            </Alert>
          ) : null}

          <Controller
            control={control}
            name="repeat"
            render={({ field }) => (
              <RadioGroup
                label="Repeat"
                layout="tiles"
                value={field.value}
                onValueChange={(next) => {
                  if (
                    next === 'ONCE' ||
                    next === 'DAILY' ||
                    next === 'WEEKLY' ||
                    next === 'MONTHLY'
                  ) {
                    field.onChange(next);
                  }
                }}
              >
                <Radio
                  variant="tile"
                  value="ONCE"
                  disabled={isPending}
                  label="One-time"
                />
                <Radio
                  variant="tile"
                  value="DAILY"
                  disabled={isPending}
                  label="Every day"
                />
                <Radio
                  variant="tile"
                  value="WEEKLY"
                  disabled={isPending}
                  label="Every week"
                />
                <Radio
                  variant="tile"
                  value="MONTHLY"
                  disabled={isPending}
                  label="Every month"
                />
              </RadioGroup>
            )}
          />

          {repeat === 'ONCE' ? (
            <TextField
              label="Due date"
              type="date"
              disabled={isPending}
              invalid={Boolean(errors.scheduledFor)}
              errorText={errors.scheduledFor?.message}
              helperText="Optional"
              {...register('scheduledFor')}
            />
          ) : null}

          {repeat === 'WEEKLY' ? (
            <Controller
              control={control}
              name="weekday"
              render={({ field }) => (
                <SelectField
                  label="Weekday"
                  required
                  value={String(field.value)}
                  disabled={isPending}
                  invalid={Boolean(errors.weekday)}
                  errorText={errors.weekday?.message}
                  onChange={(event) => {
                    field.onChange(Number(event.target.value));
                  }}
                >
                  {WEEKDAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectField>
              )}
            />
          ) : null}

          {repeat === 'MONTHLY' ? (
            <Controller
              control={control}
              name="dayOfMonth"
              render={({ field }) => (
                <SelectField
                  label="Day of month"
                  required
                  value={String(field.value)}
                  disabled={isPending}
                  invalid={Boolean(errors.dayOfMonth)}
                  errorText={errors.dayOfMonth?.message}
                  onChange={(event) => {
                    field.onChange(Number(event.target.value));
                  }}
                >
                  {Array.from({ length: 31 }, (_, index) => index + 1).map(
                    (day) => (
                      <option key={day} value={day}>
                        {formatDayOfMonth(day)}
                      </option>
                    ),
                  )}
                </SelectField>
              )}
            />
          ) : null}

          {repeat !== 'ONCE' ? (
            <p className="text-sm text-text-secondary">
              Repeating chores are added when they’re due. Existing tasks stay
              as they are.
            </p>
          ) : null}

          {errors.root?.message ? (
            <Alert variant="danger">{errors.root.message}</Alert>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="submit"
              loading={isPending}
              disabled={
                isPending ||
                membershipsUnavailable ||
                (membershipsQuery.isPending &&
                  membershipsQuery.data === undefined)
              }
            >
              Add task
            </Button>
            <Button
              type="button"
              variant="subtle"
              disabled={isPending}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Dialog.Popup>
    </Dialog.Root>
  );
}

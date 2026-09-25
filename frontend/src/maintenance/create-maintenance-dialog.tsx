import { useEffect, useId } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Radio,
  RadioGroup,
  Skeleton,
  TextArea,
  TextField,
} from '../components/ui/index.js';
import { useHomeMemberships } from '../homes/use-home-memberships.js';
import { ApiError } from '../platform/api/index.js';
import {
  createMaintenanceFormResolver,
  MAINTENANCE_DETAILS_MAX_LENGTH,
  MAINTENANCE_TITLE_MAX_LENGTH,
  toCreateMaintenanceRequest,
  type CreateMaintenanceFormValues,
} from './create-maintenance-form-schema.js';
import { useCreateMaintenance } from './use-create-maintenance.js';

const CREATE_FORM_ERROR =
  'Couldn’t create this item. Check the details and try again.';
const CREATE_UNAVAILABLE_ERROR =
  'This Home isn’t available right now. Try again later.';

function isConcealedScope(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

export type CreateMaintenanceDialogProps = {
  homeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const emptyValues: CreateMaintenanceFormValues = {
  title: '',
  details: '',
  visibility: 'HOUSEHOLD',
  audienceMembershipIds: [],
};

export function CreateMaintenanceDialog({
  homeId,
  open,
  onOpenChange,
}: CreateMaintenanceDialogProps) {
  const formId = useId();
  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<CreateMaintenanceFormValues>({
    resolver: createMaintenanceFormResolver(),
    defaultValues: emptyValues,
  });

  const visibility = useWatch({ control, name: 'visibility' });
  const audienceMembershipIds =
    useWatch({ control, name: 'audienceMembershipIds' }) ?? [];

  const membershipsQuery = useHomeMemberships({
    homeId,
    enabled: open && homeId.length > 0,
  });

  const createMutation = useCreateMaintenance();

  // Bind draft to the Home where create began; reset on Home change or close.
  useEffect(() => {
    reset(emptyValues);
  }, [open, homeId, reset]);

  const membershipsUnavailable =
    membershipsQuery.isError && isConcealedScope(membershipsQuery.error);

  const currentMembershipId = membershipsQuery.data?.currentMembershipId ?? '';
  const selectableMemberships =
    membershipsQuery.data?.memberships.filter(
      (row) => row.membershipId !== currentMembershipId,
    ) ?? [];

  const isPending = createMutation.isPending;
  const privateBlockedByScope =
    visibility === 'PRIVATE' && membershipsUnavailable;

  const submitCreate = handleSubmit(async (values) => {
    clearErrors('root');
    createMutation.reset();

    if (values.visibility === 'PRIVATE' && membershipsUnavailable) {
      setError('root', {
        type: 'server',
        message: CREATE_UNAVAILABLE_ERROR,
      });
      return;
    }

    // Never include current actor — backend unions creator Membership.
    const sanitizedAudience = values.audienceMembershipIds.filter(
      (id) => id !== currentMembershipId && id.length > 0,
    );

    try {
      await createMutation.mutateAsync({
        homeId,
        body: toCreateMaintenanceRequest({
          ...values,
          audienceMembershipIds: sanitizedAudience,
        }),
      });
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
        title="Add maintenance"
        description="Log something that needs attention in this home."
        closeLabel="Close add maintenance"
        className="max-h-[min(100dvh-2rem,44rem)]"
      >
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => void submitCreate(event)}
          noValidate
        >
          <TextField
            label="Title"
            required
            autoComplete="off"
            maxLength={MAINTENANCE_TITLE_MAX_LENGTH}
            disabled={isPending}
            invalid={Boolean(errors.title)}
            errorText={errors.title?.message}
            {...register('title')}
          />

          <TextArea
            label="Details"
            maxLength={MAINTENANCE_DETAILS_MAX_LENGTH}
            disabled={isPending}
            invalid={Boolean(errors.details)}
            errorText={errors.details?.message}
            helperText="Optional"
            rows={4}
            {...register('details')}
          />

          <Controller
            control={control}
            name="visibility"
            render={({ field }) => (
              <RadioGroup
                label="Visibility"
                value={field.value}
                onValueChange={(next) => {
                  if (next === 'HOUSEHOLD' || next === 'PRIVATE') {
                    field.onChange(next);
                  }
                }}
              >
                <Radio
                  value="HOUSEHOLD"
                  disabled={isPending}
                  label={
                    <span className="flex flex-col gap-0.5">
                      <span>Household</span>
                      <span className="text-sm font-normal text-text-secondary">
                        Visible to current roommates in this Home.
                      </span>
                    </span>
                  }
                />
                <Radio
                  value="PRIVATE"
                  disabled={isPending}
                  label={
                    <span className="flex flex-col gap-0.5">
                      <span>Private</span>
                      <span className="text-sm font-normal text-text-secondary">
                        Visible only to the roommates you choose.
                      </span>
                    </span>
                  }
                />
              </RadioGroup>
            )}
          />

          {visibility === 'PRIVATE' ? (
            <fieldset
              className="flex flex-col gap-3 rounded-xl border border-privacy-border bg-privacy-soft/40 p-3"
              disabled={isPending || membershipsUnavailable}
            >
              <legend className="px-1 text-sm font-medium text-privacy-text">
                Share with
              </legend>

              <p className="text-sm text-text-secondary">
                You’re included automatically.
              </p>

              {membershipsUnavailable ? (
                <Alert variant="danger" title="Home unavailable">
                  It may not exist, or you may not be able to open it right now.
                </Alert>
              ) : null}

              {membershipsQuery.isPending &&
              membershipsQuery.data === undefined &&
              !membershipsUnavailable ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                  <Skeleton className="h-11 w-full" announced />
                  <Skeleton className="h-11 w-full" />
                </div>
              ) : null}

              {membershipsQuery.isSuccess &&
              selectableMemberships.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No other roommates to add. This will be visible only to you.
                </p>
              ) : null}

              {membershipsQuery.isSuccess &&
              selectableMemberships.length > 0 ? (
                <Controller
                  control={control}
                  name="audienceMembershipIds"
                  render={({ field }) => (
                    <ul className="flex list-none flex-col gap-1 p-0">
                      {selectableMemberships.map((row) => {
                        const checked = field.value.includes(row.membershipId);
                        return (
                          <li key={row.membershipId}>
                            <Checkbox
                              label={row.name}
                              checked={checked}
                              disabled={isPending}
                              onCheckedChange={(next) => {
                                if (next) {
                                  field.onChange([
                                    ...new Set([
                                      ...field.value,
                                      row.membershipId,
                                    ]),
                                  ]);
                                  return;
                                }
                                field.onChange(
                                  field.value.filter(
                                    (id) => id !== row.membershipId,
                                  ),
                                );
                              }}
                              className="w-full"
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                />
              ) : null}

              {membershipsQuery.isSuccess &&
              selectableMemberships.length > 0 &&
              audienceMembershipIds.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  If you don’t choose anyone, only you will be able to see this.
                </p>
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
            </fieldset>
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
                privateBlockedByScope ||
                (visibility === 'PRIVATE' &&
                  membershipsQuery.isPending &&
                  membershipsQuery.data === undefined)
              }
            >
              Add maintenance
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

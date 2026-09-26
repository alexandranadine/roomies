import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { Alert, Button, TextField } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { createHome } from './create-home-api.js';
import {
  createHomeFormResolver,
  type CreateHomeFormValues,
  toCreateHomeRequest,
} from './create-home-form-schema.js';
import { handlePassiveAuthLoss } from './clear-private-home-queries.js';
import { seedCurrentUserHomesCacheAfterCreate } from './home-list-cache.js';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import { getDefaultBrowserTimeZone } from './supported-timezones.js';
import { TimezoneField } from './timezone-field.js';

const CREATE_HOME_FORM_ERROR =
  'Couldn’t create this Home. Check the details and try again.';

export function CreateHomeForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm<CreateHomeFormValues>({
    resolver: createHomeFormResolver(),
    defaultValues: {
      name: '',
      timezone: getDefaultBrowserTimeZone() ?? '',
    },
  });

  const createHomeMutation = useMutation({
    mutationFn: createHome,
    onSuccess: (created) => {
      seedCurrentUserHomesCacheAfterCreate(queryClient, created);
      void navigate(`/homes/${created.home.id}`, { replace: true });
      void queryClient.invalidateQueries({
        queryKey: currentUserHomesQueryKey,
      });
    },
  });

  const submitCreateHome = handleSubmit(async (values) => {
    createHomeMutation.reset();
    try {
      await createHomeMutation.mutateAsync(toCreateHomeRequest(values));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handlePassiveAuthLoss(queryClient);
        return;
      }
      setError('root', { type: 'server', message: CREATE_HOME_FORM_ERROR });
    }
  });

  const isPending = createHomeMutation.isPending;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => void submitCreateHome(event)}
      noValidate
    >
      <TextField
        label="Home name"
        required
        autoComplete="off"
        disabled={isPending}
        invalid={Boolean(errors.name)}
        errorText={errors.name?.message}
        {...register('name')}
      />

      <Controller
        control={control}
        name="timezone"
        render={({ field }) => (
          <TimezoneField
            label="Timezone"
            required
            disabled={isPending}
            invalid={Boolean(errors.timezone)}
            errorText={errors.timezone?.message}
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            name={field.name}
          />
        )}
      />

      {errors.root?.message ? (
        <Alert variant="danger" title="Couldn’t create this Home">
          {errors.root.message}
        </Alert>
      ) : null}

      <Button
        type="submit"
        className="w-full"
        loading={isPending}
        disabled={isPending}
      >
        Create home
      </Button>
    </form>
  );
}

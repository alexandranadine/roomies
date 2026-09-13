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
import { clearPrivateHomeQueryState } from './clear-private-home-queries.js';
import {
  currentUserHomesQueryKey,
  currentUserQueryKey,
} from './home-query-keys.js';
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
      void queryClient
        .invalidateQueries({
          queryKey: currentUserHomesQueryKey,
        })
        .then(() => {
          void navigate(`/homes/${created.home.id}`, { replace: true });
        });
    },
  });

  const submitCreateHome = handleSubmit(async (values) => {
    createHomeMutation.reset();
    try {
      await createHomeMutation.mutateAsync(toCreateHomeRequest(values));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearPrivateHomeQueryState(queryClient);
        void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
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
        <Alert variant="danger">{errors.root.message}</Alert>
      ) : null}

      <div>
        <Button type="submit" loading={isPending} disabled={isPending}>
          Create Home
        </Button>
      </div>
    </form>
  );
}

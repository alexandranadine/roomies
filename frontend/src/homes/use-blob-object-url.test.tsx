import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBlobObjectUrl } from './use-blob-object-url.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useBlobObjectUrl', () => {
  it('creates an object URL for a Blob and revokes it when the Blob changes or unmounts', () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob) => `blob:test:${(blob as Blob).size}`);
    const revokeObjectURL = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});

    const first = new Blob(['one']);
    const second = new Blob(['second-blob']);
    const { result, rerender, unmount } = renderHook(
      ({ blob }: { blob: Blob | null }) => useBlobObjectUrl(blob),
      { initialProps: { blob: first } },
    );

    expect(createObjectURL).toHaveBeenCalledWith(first);
    expect(result.current).toBe(`blob:test:${first.size}`);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    rerender({ blob: second });
    expect(createObjectURL).toHaveBeenCalledWith(second);
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:test:${first.size}`);
    expect(result.current).toBe(`blob:test:${second.size}`);

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:test:${second.size}`);
  });

  it('does not create an object URL when there is no photo Blob', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const { result } = renderHook(() => useBlobObjectUrl(null));
    expect(result.current).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

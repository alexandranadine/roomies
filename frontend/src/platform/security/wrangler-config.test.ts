import { describe, expect, it } from 'vitest';
import wrangler from '../../../wrangler.json' with { type: 'json' };

describe('Cloudflare Workers Static Assets config', () => {
  it('uses Workers Static Assets SPA fallback without a Worker script', () => {
    expect(wrangler.name).toBe('roomies-frontend-staging');
    expect('main' in wrangler).toBe(false);
    expect('pages_build_output_dir' in wrangler).toBe(false);
    expect(wrangler.assets.directory).toBe('./dist');
    expect(wrangler.assets.not_found_handling).toBe('single-page-application');
  });
});

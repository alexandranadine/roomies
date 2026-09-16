import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { areSameSiteOrigins, registrableSite } from './same-site-origins.js';

void describe('same-site origins', () => {
  void it('treats apex and API subdomain as the same site', () => {
    assert.equal(registrableSite('roomies.example'), 'roomies.example');
    assert.equal(registrableSite('api.roomies.example'), 'roomies.example');
    assert.equal(
      areSameSiteOrigins(
        'https://roomies.example',
        'https://api.roomies.example',
      ),
      true,
    );
    assert.equal(
      areSameSiteOrigins(
        'https://app.roomies.example',
        'https://api.roomies.example',
      ),
      true,
    );
  });

  void it('rejects unrelated and provider-hosted cross-site pairs', () => {
    assert.equal(
      areSameSiteOrigins('https://roomies.example', 'https://evil.example'),
      false,
    );
    assert.equal(
      areSameSiteOrigins(
        'https://roomies-frontend-staging.example.workers.dev',
        'https://roomies-api-staging.up.railway.app',
      ),
      false,
    );
    assert.equal(
      areSameSiteOrigins('https://foo.workers.dev', 'https://bar.workers.dev'),
      false,
    );
  });
});

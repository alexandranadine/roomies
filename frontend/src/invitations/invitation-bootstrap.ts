import { captureInvitationFragment } from './capture-invitation-fragment.js';

/**
 * First-import side effect from `main.tsx`. Runs before React, the router, and
 * any application effects so the fragment is gone before they observe the URL.
 */
captureInvitationFragment();

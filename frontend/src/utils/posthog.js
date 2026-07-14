import posthog from 'posthog-js';

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

export const isPosthogConfigured = Boolean(POSTHOG_KEY);

export function initPosthog() {
  if (isPosthogConfigured) {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      person_profiles: 'identified_only', // recommended settings
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: false, // disable massive automatic event tracking to keep data clean
    });
    console.log('[PostHog] Initialized successfully');
  } else {
    console.log('[PostHog] Key missing. Analytics disabled.');
  }
}

export { posthog };

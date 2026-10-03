# Pocket Notes

Pocket Notes is an offline-first SvelteKit notes app. Notes and voice recordings are stored locally in IndexedDB; no account, external database, or remote API is required.

## Run locally

```sh
npm install
npm run dev
```

Create a production build with `npm run build`, then serve it with `npm run preview`. Service workers and microphone access require a secure context: use HTTPS in production, or `localhost` during development and preview. Open the app once while online so the browser can install the service worker and cache the app shell; after that, reloads and note operations work offline.

## Features

- Create, edit, search, filter, sort, and delete text and voice notes.
- Mark notes active or completed, then browse All or Completed notes.
- Sort notes by name or most recently edited date (the default).
- Record audio with the browser microphone and play recordings back later.
- Persist notes, completion status, and voice recordings in IndexedDB.
- Cache the app shell with the SvelteKit service worker for offline launches.
- Save and edit notes locally in IndexedDB regardless of network status. No online connection is needed for note operations.
- Install as a standalone PWA with Pocket Notes branding, switch appearance, and use the responsive mobile layout.

## Storage and synchronization

The source of truth is this browser's IndexedDB. The app has no remote sync service or server-side database, so notes remain on this device and are not uploaded or synchronized across devices.

Clearing browser site data removes locally stored notes and recordings. Voice recordings require microphone permission and browser support for `MediaRecorder`.

# Pocket Notes

Pocket Notes is an offline-first SvelteKit notes app. Notes and voice recordings are stored locally in IndexedDB; no account, external database, or remote API is required.

## Run locally

```sh
npm install
npm run dev
```

Create a production build with `npm run build`, then serve it with `npm run preview`. Service workers and microphone access require a secure context: use HTTPS in production, or `localhost` during development.

## Features

- Create, edit, search, filter, sort, and delete text and voice notes.
- Mark notes active or completed, then browse All, Active, and Completed lists.
- Sort notes by name or most recently edited date (the default).
- Record audio with the browser microphone and play recordings back later.
- Persist notes and a mutation outbox in IndexedDB.
- Cache the app shell with the SvelteKit service worker for offline launches.
- Queue local mutations while offline and process the outbox after connectivity returns (using Background Sync when supported).
- Install as a standalone PWA with Pocket Notes branding, switch appearance, and use the responsive mobile layout.

## Storage and synchronization

The source of truth is this browser's IndexedDB. The outbox records creates, updates, and deletes, and is drained on reconnect; this keeps local changes durable across reloads and supports background processing. There is intentionally no remote sync service or server-side database in this project, so notes do not synchronize to other devices or browsers. Cross-device synchronization requires a separately configured server/API.

Clearing browser site data removes locally stored notes and recordings. Voice recordings require microphone permission and browser support for `MediaRecorder`.

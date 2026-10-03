import { assets, immutable, prerendered } from '$app/manifest';
import { version } from '$app/env';

const CACHE = `pocket-notes-${version}`;
const APP_SHELL = [
	...new Set([...immutable, ...assets, ...prerendered].map(({ path }) => path).concat('/'))
];

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(keys.filter((key) => key.startsWith('pocket-notes-') && key !== CACHE).map((key) => caches.delete(key)))
		)
	);
	self.clients.claim();
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(CACHE).then((cache) => cache.put('/', copy));
					return response;
				})
				.catch(async () => (await caches.match(request)) ?? (await caches.match('/')))
		);
		return;
	}

	event.respondWith(
		caches.match(request).then((cached) => {
			if (cached) return cached;
			return fetch(request).then((response) => {
				if (response.ok) {
					const copy = response.clone();
					caches.open(CACHE).then((cache) => cache.put(request, copy));
				}
				return response;
			});
		})
	);
});

async function clearQueuedMutations() {
	const database = await new Promise((resolve, reject) => {
		const request = indexedDB.open('pocket-notes', 1);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Unable to open the local changes queue.'));
	});
	const transaction = database.transaction('outbox', 'readwrite');
	await new Promise((resolve, reject) => {
		transaction.oncomplete = resolve;
		transaction.onerror = () => reject(transaction.error ?? new Error('Unable to process the local changes queue.'));
		transaction.objectStore('outbox').clear();
	});
	database.close();
}

async function notifyClients() {
	const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	for (const client of clients) client.postMessage({ type: 'OUTBOX_SYNCED' });
}

self.addEventListener('sync', (event) => {
	if (event.tag !== 'pocket-notes-outbox') return;
	event.waitUntil(clearQueuedMutations().then(notifyClients));
});

import { assets, immutable, prerendered } from '$app/manifest';
import { version } from '$app/env';

const CACHE = `pocket-notes-${version}`;
const APP_SHELL = [
	...new Set([...immutable, ...assets, ...prerendered].map(({ path }) => path).concat('/'))
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(APP_SHELL);
			await self.skipWaiting();
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((key) => key.startsWith('pocket-notes-') && key !== CACHE)
					.map((key) => caches.delete(key))
			);
			await self.clients.claim();
		})()
	);
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

	if (request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					const response = await fetch(request);
					if (response.ok) {
						const cache = await caches.open(CACHE);
						await cache.put(request, response.clone());
						if (new URL(request.url).pathname === '/') {
							await cache.put('/', response.clone());
						}
					}
					return response;
				} catch (error) {
					const cached =
						(await caches.match(request)) ??
						(await caches.match(new URL('/', self.location.origin).href));
					if (cached) return cached;
					throw error;
				}
			})()
		);
		return;
	}

	event.respondWith(
		(async () => {
			const cached = await caches.match(request);
			if (cached) return cached;

			const response = await fetch(request);
			if (response.ok) {
				const cache = await caches.open(CACHE);
				await cache.put(request, response.clone());
			}
			return response;
		})()
	);
});
const DB_NAME = 'pocket-notes';
const DB_VERSION = 1;

let databasePromise;

function openDatabase() {
	if (databasePromise) return databasePromise;

	databasePromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = () => {
			const database = request.result;
			const notes = database.createObjectStore('notes', { keyPath: 'id' });
			notes.createIndex('updatedAt', 'updatedAt');
			database.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Unable to open local notes storage.'));
		request.onblocked = () => reject(new Error('Local notes storage is blocked by another open tab.'));
	});

	return databasePromise;
}

function transactionDone(transaction) {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('Local storage transaction failed.'));
		transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was cancelled.'));
	});
}

export async function getNotes() {
	const database = await openDatabase();
	const transaction = database.transaction('notes', 'readonly');
	const done = transactionDone(transaction);
	const request = transaction.objectStore('notes').getAll();
	const notes = await new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Unable to read notes.'));
	});
	await done;
	return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveNote(note, action) {
	const database = await openDatabase();
	const transaction = database.transaction(['notes', 'outbox'], 'readwrite');
	const done = transactionDone(transaction);
	transaction.objectStore('notes').put(note);
	transaction.objectStore('outbox').add({
		action,
		noteId: note.id,
		payload: note,
		queuedAt: Date.now()
	});
	await done;
}

export async function deleteNote(id) {
	const database = await openDatabase();
	const transaction = database.transaction(['notes', 'outbox'], 'readwrite');
	const done = transactionDone(transaction);
	transaction.objectStore('notes').delete(id);
	transaction.objectStore('outbox').add({
		action: 'delete',
		noteId: id,
		queuedAt: Date.now()
	});
	await done;
}

export async function clearOutbox() {
	const database = await openDatabase();
	const transaction = database.transaction('outbox', 'readwrite');
	const done = transactionDone(transaction);
	transaction.objectStore('outbox').clear();
	await done;
}

export async function getOutboxCount() {
	const database = await openDatabase();
	const transaction = database.transaction('outbox', 'readonly');
	const done = transactionDone(transaction);
	const request = transaction.objectStore('outbox').count();
	const count = await new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Unable to check pending changes.'));
	});
	await done;
	return count;
}

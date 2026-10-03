const DB_NAME = 'pocket-notes';

let databasePromise;

function openDatabase() {
	if (databasePromise) return databasePromise;

	databasePromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME);

		request.onupgradeneeded = (event) => {
			const database = request.result;
			if (!database.objectStoreNames.contains('notes')) {
				const notes = database.createObjectStore('notes', { keyPath: 'id' });
				notes.createIndex('updatedAt', 'updatedAt');
			}
		};

		request.onsuccess = () => {
			const database = request.result;
			database.onversionchange = () => {
				database.close();
				databasePromise = undefined;
			};
			resolve(database);
		};
		request.onerror = () => {
			databasePromise = undefined;
			reject(request.error ?? new Error('Unable to open local notes storage.'));
		};
		request.onblocked = () => {
			databasePromise = undefined;
			reject(new Error('Local notes storage is blocked by another open tab.'));
		};
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
		request.onsuccess = () => {
			const database = request.result;
			database.onversionchange = () => {
				database.close();
				databasePromise = undefined;
			};
			resolve(database);
		};
		request.onerror = () => reject(request.error ?? new Error('Unable to read notes.'));
	});
	await done;
	return notes;
}

export async function saveNote(note) {
	const database = await openDatabase();
	const transaction = database.transaction('notes', 'readwrite');
	const done = transactionDone(transaction);
	transaction.objectStore('notes').put(note);
	await done;
}

export async function deleteNote(id) {
	const database = await openDatabase();
	const transaction = database.transaction('notes', 'readwrite');
	const done = transactionDone(transaction);
	transaction.objectStore('notes').delete(id);
	await done;
}
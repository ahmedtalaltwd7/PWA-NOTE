<script>
	import { onDestroy, onMount } from 'svelte';
	import { deleteNote, getNotes, saveNote } from '#lib/notes-db';

	let notes = $state([]);
	let isLoading = $state(true);
	let isOnline = $state(true);
	let offlineReady = $state(false);
	let isDark = $state(false);
	let search = $state('');
	let typeFilter = $state('all');
	let statusFilter = $state('all');
	let sortBy = $state('date');
	let editorOpen = $state(false);
	let editingId = $state(null);
	let title = $state('');
	let content = $state('');
	let audioBlob = $state(null);
	let audioUrl = $state('');
	let isRecording = $state(false);
	let recordingSeconds = $state(0);
	let toast = $state('');
	let toastTimer;
	let recorder;
	let mediaStream;
	let recordingInterval;
	const audioUrls = new Map();

	function normalizeSearchText(value) {
		return String(value ?? '')
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^\p{L}\p{N}]+/gu, ' ')
			.toLocaleLowerCase();
	}

	const filteredNotes = $derived.by(() => {
		const queryWords = normalizeSearchText(search).trim().split(/\s+/).filter(Boolean);
		const matching = notes.filter((note) => {
			const matchesType =
				typeFilter === 'all' || (typeFilter === 'voice' ? Boolean(note.audio) : !note.audio);
			const matchesStatus = statusFilter === 'all' || Boolean(note.completed);
			const searchableText = normalizeSearchText(`${note.title} ${note.content}`);
			const matchesSearch = queryWords.every((word) => searchableText.includes(word));
			return matchesType && matchesStatus && matchesSearch;
		});

		const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
		return matching.sort((a, b) => {
			const dateDifference =
				(Number(b.updatedAt) || Number(b.createdAt) || 0) -
				(Number(a.updatedAt) || Number(a.createdAt) || 0);
			return sortBy === 'name'
				? collator.compare(a.title || '', b.title || '') || dateDifference
				: dateDifference || collator.compare(a.title || '', b.title || '');
		});
	});
	const notesByType = $derived.by(() =>
		notes.filter(
			(note) => typeFilter === 'all' || (typeFilter === 'voice' ? note.audio : !note.audio)
		)
	);

	function notify(message) {
		toast = message;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 3200);
	}

	function updateAudioPreview(blob) {
		if (audioUrl) URL.revokeObjectURL(audioUrl);
		audioBlob = blob;
		audioUrl = blob ? URL.createObjectURL(blob) : '';
	}

	async function refreshNotes() {
		notes = await getNotes();
		const currentIds = new Set(notes.map((note) => note.id));
		for (const [id, cached] of audioUrls) {
			if (!currentIds.has(id)) {
				URL.revokeObjectURL(cached.url);
				audioUrls.delete(id);
			}
		}
	}

	function audioSource(note) {
		const cached = audioUrls.get(note.id);
		if (cached?.updatedAt !== note.updatedAt) {
			if (cached) URL.revokeObjectURL(cached.url);
			const url = URL.createObjectURL(note.audio);
			audioUrls.set(note.id, { url, updatedAt: note.updatedAt });
			return url;
		}
		return cached.url;
	}

	async function loadNotes() {
		isLoading = true;
		try {
			await refreshNotes();
		} catch (error) {
			console.error('Could not load local notes:', error);
			notify('Could not open your local notes. Please try again.');
		} finally {
			isLoading = false;
		}
	}

	function openEditor(note = null) {
		editingId = note?.id ?? null;
		title = note?.title ?? '';
		content = note?.content ?? '';
		updateAudioPreview(note?.audio ?? null);
		recordingSeconds = 0;
		editorOpen = true;
	}

	function closeEditor() {
		stopRecording();
		editorOpen = false;
		editingId = null;
		title = '';
		content = '';
		updateAudioPreview(null);
	}

	async function handleSave(event) {
		event.preventDefault();
		if (isRecording) {
			notify('Stop the recording before saving your note.');
			return;
		}

		const cleanTitle = title.trim();
		const cleanContent = content.trim();
		if (!cleanTitle && !cleanContent && !audioBlob) {
			notify('Add a title, a few words, or a voice recording first.');
			return;
		}

		const existing = notes.find((note) => note.id === editingId);
		const now = Date.now();
		const note = {
			id: editingId ?? crypto.randomUUID(),
			title: cleanTitle || 'Untitled note',
			content: cleanContent,
			audio: audioBlob,
			completed: existing?.completed ?? false,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now
		};

		try {
			await saveNote(note);
			await refreshNotes();
			closeEditor();
			notify(isOnline ? 'Note saved on this device.' : 'Saved offline — available on this device.');

		} catch (error) {
			console.error('Could not save note:', error);
			notify('Your note could not be saved. Check device storage and try again.');
		}
	}

	async function removeNote(note) {
		if (!confirm(`Delete “${note.title}”? This cannot be undone.`)) return;
		try {
			await deleteNote(note.id);
			await refreshNotes();
			notify(isOnline ? 'Note deleted.' : 'Deleted offline — saved on this device.');
		} catch (error) {
			console.error('Could not delete note:', error);
			notify('This note could not be deleted. Please try again.');
		}
	}

	async function toggleCompleted(note) {
		const updatedNote = { ...note, completed: !note.completed, updatedAt: Date.now() };
		try {
			await saveNote(updatedNote);
			await refreshNotes();
			notify(updatedNote.completed ? 'Note marked completed.' : 'Note moved back to active.');
		} catch (error) {
			console.error('Could not update note status:', error);
			notify('Note status could not be updated. Please try again.');
		}
	}

	async function startRecording() {
		if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
			notify('Audio recording is not supported by this browser.');
			return;
		}
		try {
			mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const preferredType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
				? 'audio/webm;codecs=opus'
				: '';
			recorder = new MediaRecorder(mediaStream, preferredType ? { mimeType: preferredType } : {});
			const chunks = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			recorder.onstop = () => {
				if (chunks.length) updateAudioPreview(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
				mediaStream?.getTracks().forEach((track) => track.stop());
				mediaStream = null;
				isRecording = false;
				clearInterval(recordingInterval);
			};
			recorder.start();
			recordingSeconds = 0;
			isRecording = true;
			recordingInterval = setInterval(() => recordingSeconds++, 1000);
		} catch (error) {
			console.error('Could not start audio recording:', error);
			notify(error.name === 'NotAllowedError' ? 'Allow microphone access to record a voice note.' : 'Microphone unavailable. Please try again.');
		}
	}

	function stopRecording() {
		if (recorder?.state === 'recording') recorder.stop();
		else {
			mediaStream?.getTracks().forEach((track) => track.stop());
			mediaStream = null;
			isRecording = false;
			clearInterval(recordingInterval);
		}
	}

	function formatDuration(seconds) {
		return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
	}

	function formatDate(timestamp) {
		const date = new Date(timestamp);
		const today = new Date();
		const sameDay = date.toDateString() === today.toDateString();
		const yesterday = new Date(today);
		yesterday.setDate(today.getDate() - 1);
		const dayLabel = sameDay ? 'Today' : date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		return `${dayLabel} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
	}

	function onOnline() {
		isOnline = true;
		notify('Back online — your notes are still saved on this device.');
	}
	function onOffline() {
		isOnline = false;
		notify('You’re offline — notes are saved on this device.');
	}


	async function waitForWorker(worker) {
		if (worker.state === 'activated') return;
		if (worker.state === 'redundant') throw new Error('The service worker installation failed.');

		await new Promise((resolve, reject) => {
			const onStateChange = () => {
				if (worker.state === 'activated') {
					worker.removeEventListener('statechange', onStateChange);
					resolve();
				} else if (worker.state === 'redundant') {
					worker.removeEventListener('statechange', onStateChange);
					reject(new Error('The service worker installation failed.'));
				}
			};
			worker.addEventListener('statechange', onStateChange);
			onStateChange();
		});
	}

	async function registerServiceWorker() {
		if (!('serviceWorker' in navigator)) return;
		try {
			const registration = await navigator.serviceWorker.register('/service-worker.js');
			if (navigator.onLine) {
				try {
					await registration.update();
				} catch (error) {
					if (!registration.active) throw error;
					console.warn('Could not check for a service worker update; using the installed offline cache:', error);
				}
			}

			const installingWorker = registration.installing;
			if (installingWorker) await waitForWorker(installingWorker);
			const readyRegistration = await navigator.serviceWorker.ready;
			if (!readyRegistration.active) throw new Error('The offline app shell has no active worker.');
			await waitForWorker(readyRegistration.active);
			offlineReady = true;
		} catch (error) {
			console.error('Could not prepare the offline app shell:', error);
			notify('Offline setup is not ready yet. Keep this page online while it finishes.');
		}
	}
	function toggleTheme() {
		isDark = !isDark;
		localStorage.setItem('pocket-notes-theme', isDark ? 'dark' : 'light');
	}

	onMount(() => {
		isOnline = navigator.onLine;
		isDark = localStorage.getItem('pocket-notes-theme') === 'dark';
		void loadNotes();
		void registerServiceWorker();
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
		return () => {
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
		};
	});

	onDestroy(() => {
		clearTimeout(toastTimer);
		clearInterval(recordingInterval);
		mediaStream?.getTracks().forEach((track) => track.stop());
		if (audioUrl) URL.revokeObjectURL(audioUrl);
		for (const cached of audioUrls.values()) URL.revokeObjectURL(cached.url);
	});
</script>

<svelte:head>
	<title>Pocket Notes — your thoughts, in one place</title>
	<meta name="description" content="A private, offline-first home for your notes and voice memos." />
	<meta name="theme-color" content="#507b68" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<link rel="apple-touch-icon" href="/icons/icon-192.svg" />
</svelte:head>

<div class:dark={isDark} class="app-shell">
	<aside class="sidebar">
		<a class="brand" href="/" aria-label="Pocket Notes home">
			<span class="brand-mark">
				<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 8.5A2.5 2.5 0 0 1 9.5 6H24v19H9.5A2.5 2.5 0 0 1 7 22.5z" /><path d="M10 6v19M14 12h6M14 15.5h6M13 20h8l-1 2h-6z" /></svg>
			</span>
			<span class="brand-name">pocket<span>notes</span></span>
		</a>
		<div class="sidebar-rule"></div>
		<p class="eyebrow">YOUR SPACE</p>
		<button class:active={typeFilter === 'all'} class="nav-item" onclick={() => (typeFilter = 'all')}>
			<span class="nav-icon">▤</span><span>All notes</span><span class="nav-count">{notes.length}</span>
		</button>
		<button class:active={typeFilter === 'text'} class="nav-item" onclick={() => (typeFilter = 'text')}>
			<span class="nav-icon">≡</span><span>Text notes</span>
		</button>
		<button class:active={typeFilter === 'voice'} class="nav-item" onclick={() => (typeFilter = 'voice')}>
			<span class="nav-icon">◖</span><span>Voice notes</span>
		</button>
		<div class="sidebar-bottom">
			<div class="privacy-card">
				<span class="privacy-icon">✳</span>
				<div><strong>Just for you</strong><p>Your notes live on this device, even offline.</p></div>
			</div>
			<button class="nav-item theme-button" onclick={toggleTheme}>
				<span class="nav-icon">{isDark ? '☼' : '◐'}</span><span>{isDark ? 'Light appearance' : 'Dark appearance'}</span>
			</button>
			<div class="sidebar-foot"><span class:offline={!isOnline} class="status-dot"></span>{isOnline ? (offlineReady ? 'Offline-ready on this device' : 'Preparing offline access') : 'Working offline'}</div>
		</div>
	</aside>

	<main class="main-content">
		<header class="topbar">
			<div class="mobile-brand">
				<span class="brand-mark small"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 8.5A2.5 2.5 0 0 1 9.5 6H24v19H9.5A2.5 2.5 0 0 1 7 22.5z" /><path d="M10 6v19M14 12h6M14 15.5h6M13 20h8l-1 2h-6z" /></svg></span>
				<span class="brand-name">pocket<span>notes</span></span>
			</div>
			<div class="topbar-status"><span class:offline={!isOnline} class="status-dot"></span>{isOnline ? (offlineReady ? 'Offline ready' : 'Getting ready') : 'Offline mode'}</div>
			<div class="topbar-actions">
				<button class="icon-button theme-mobile" aria-label={isDark ? 'Switch to light appearance' : 'Switch to dark appearance'} onclick={toggleTheme}>{isDark ? '☼' : '◐'}</button>
				<button class="primary-button top-create" onclick={() => openEditor()}><span>＋</span> New note</button>
			</div>
		</header>

		<section class="content">
			<div class="welcome-row">
				<div>
					<p class="eyebrow">YOUR PERSONAL SPACE</p>
					<h1>Notes that go<br class="mobile-break" /> wherever you do<span class="title-period">.</span></h1>
					<p class="subtitle">A little place for everything on your mind.</p>
				</div>
				<div class="welcome-illustration" aria-hidden="true">
					<div class="sun-shape"></div><div class="leaf leaf-one"></div><div class="leaf leaf-two"></div>
					<div class="paper-shape"><i></i><i></i><i></i></div>
					<div class="sparkle sparkle-one">✳</div><div class="sparkle sparkle-two">✦</div>
				</div>
			</div>

			<div class="list-toolbar">
				<div class="list-heading">
					<h2>{statusFilter === 'completed' ? 'Completed' : typeFilter === 'voice' ? 'Voice notes' : typeFilter === 'text' ? 'Text notes' : 'Your notes'}</h2>
					<span class="note-count">{filteredNotes.length} {filteredNotes.length === 1 ? 'note' : 'notes'}</span>
				</div>
				<div class="status-sort-row">
					<div class="status-tabs" role="group" aria-label="Filter notes by completion">
						<button class:active={statusFilter === 'all'} class="status-tab" aria-pressed={statusFilter === 'all'} onclick={() => (statusFilter = 'all')}>All <span>{notesByType.length}</span></button>
						<button class:active={statusFilter === 'completed'} class="status-tab" aria-pressed={statusFilter === 'completed'} onclick={() => (statusFilter = 'completed')}>Completed <span>{notesByType.filter((note) => note.completed).length}</span></button>
					</div>
					<label class="sort-control">
						<span>Sort</span>
						<select aria-label="Sort notes" bind:value={sortBy}>
							<option value="date">Date (newest)</option>
							<option value="name">Name (A–Z)</option>
						</select>
					</label>
				</div>
				<div class="toolbar-controls">
					<label class="search-box">
						<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.8"></circle><path d="m13.2 13.2 4 4"></path></svg>
						<input aria-label="Search notes" bind:value={search} placeholder="Search your notes..." />
						{#if search}<button class="clear-search" aria-label="Clear search" onclick={() => (search = '')}>×</button>{/if}
					</label>
					<button class="refresh-button" aria-label="Refresh notes" onclick={() => void loadNotes()} title="Refresh notes">↻</button>
				</div>
			</div>

			{#if isLoading}
				<div class="notes-grid" aria-label="Loading notes">
					{#each [1, 2, 3] as item (item)}
						<div class="note-skeleton"><div class="skeleton-line short"></div><div class="skeleton-line"></div><div class="skeleton-line medium"></div><div class="skeleton-footer"></div></div>
					{/each}
				</div>
			{:else if filteredNotes.length}
				<div class="notes-grid">
					{#each filteredNotes as note (note.id)}
						<article class:completed={note.completed} class="note-card">
							<div class="card-topline">
								<span class:voice-badge={note.audio} class="note-type"><span>{note.audio ? '◖' : '≡'}</span>{note.audio ? 'VOICE NOTE' : 'TEXT NOTE'}</span>
								<div class="card-actions">
									<button class:complete-action-done={note.completed} class="card-action complete-action" aria-label={note.completed ? `Mark ${note.title} active` : `Complete ${note.title}`} aria-pressed={note.completed} title={note.completed ? 'Mark active' : 'Mark completed'} onclick={() => void toggleCompleted(note)}>
										<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.3 8.1 14l7.8-8" /></svg>
									</button>
									<button class="card-action" aria-label="Edit {note.title}" title="Edit note" onclick={() => openEditor(note)}>
										<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m13.8 3.2 3 3L7 16H4v-3zM12 5l3 3" /></svg>
									</button>
									<button class="card-action delete-action" aria-label="Delete {note.title}" title="Delete note" onclick={() => void removeNote(note)}>
										<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2m2 0-.7 10H6.7L6 6m3 3v4m2-4v4" /></svg>
									</button>
								</div>
							</div>
							<button class="note-open" onclick={() => openEditor(note)} aria-label="Open {note.title}">
								<h3><span class:completed-title={note.completed}>{note.title || 'Untitled note'}</span>{#if note.completed}<span class="completed-label">COMPLETED</span>{/if}</h3>
								{#if note.content}<p class="note-preview">{note.content}</p>{:else if note.audio}<p class="note-preview voice-description">A voice note, saved for later.</p>{:else}<p class="note-preview muted-preview">No additional details</p>{/if}
							</button>
							{#if note.audio}
								<audio class="audio-player" controls preload="none" src={audioSource(note)} aria-label="Play voice note: {note.title}"></audio>
							{/if}
							<div class="card-footer"><span class="date-icon">◷</span><span>{formatDate(note.updatedAt)}</span>{#if note.updatedAt !== note.createdAt}<span class="edited-tag">EDITED</span>{/if}</div>
						</article>
					{/each}
				</div>
			{:else if search}
				<div class="empty-state search-empty"><div class="empty-art search-art"><span>⌕</span></div><h3>No notes found</h3><p>We couldn't find anything matching “{search}”.<br />Try a different search.</p><button class="text-button" onclick={() => (search = '')}>Clear search</button></div>
			{:else}
				<div class="empty-state">
					<div class="empty-art"><div class="empty-paper"><span></span><span></span><span></span></div><b>✦</b></div>
					<h3>{statusFilter === 'completed' ? 'Nothing completed yet' : typeFilter !== 'all' ? `No ${typeFilter} notes here` : 'A fresh page'}</h3>
					<p>{statusFilter === 'completed' ? 'Finished notes will find a home here.' : 'Every good thought starts somewhere.<br />Make this space yours.'}</p>
					<button class="primary-button empty-create" onclick={() => openEditor()}><span>＋</span> Create your first note</button>
				</div>
			{/if}
			<div class="bottom-note"><span>✳</span> Your notes are private and stored on this device.</div>
		</section>
	</main>

	<button class="mobile-fab" aria-label="Create a new note" onclick={() => openEditor()}>＋</button>
	{#if toast}<div class="toast" role="status"><span class="toast-icon">{toast.includes('saved') || toast.includes('Saved') ? '✓' : '✳'}</span>{toast}</div>{/if}

	{#if editorOpen}
		<div class="modal-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && closeEditor()}>
			<div class="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title" tabindex="-1">
				<div class="modal-header">
					<div><p class="eyebrow">{editingId ? 'MAKE IT YOURS' : 'CAPTURE A THOUGHT'}</p><h2 id="editor-title">{editingId ? 'Edit your note' : 'New note'}</h2></div>
					<button class="modal-close" aria-label="Close editor" onclick={closeEditor}>×</button>
				</div>
				<form onsubmit={handleSave}>
					<label class="field-label" for="note-title">TITLE</label>
					<input id="note-title" class="title-input" bind:value={title} maxlength="120" placeholder="Give this note a name..." />
					<label class="field-label content-label" for="note-content">YOUR THOUGHTS <span>OPTIONAL WITH VOICE</span></label>
					<textarea id="note-content" bind:value={content} placeholder="Start writing... anything on your mind." rows="6"></textarea>
					<div class="recording-panel">
						<div class="recording-copy"><span class:recording-pulse={isRecording} class="mic-indicator">{isRecording ? '●' : '◖'}</span><div><strong>{isRecording ? 'Recording in progress' : audioBlob ? 'Voice note ready' : 'Add a voice note'}</strong><small>{isRecording ? `Recording · ${formatDuration(recordingSeconds)}` : audioBlob ? 'Recorded audio is saved with this note' : 'Record a quick thought, hands-free'}</small></div></div>
						{#if isRecording}<div class="waveform" aria-hidden="true">{#each Array(18) as _, i}<i style={`--bar:${18 + ((i * 13) % 28)}px;--delay:${(i % 7) * 0.08}s`}></i>{/each}</div>{/if}
						<button type="button" class:recording-button={isRecording} class="record-button" onclick={isRecording ? stopRecording : startRecording}>{isRecording ? 'Stop' : audioBlob ? 'Re-record' : 'Record'}</button>
					</div>
					{#if audioUrl && !isRecording}
						<div class="recording-preview"><audio controls src={audioUrl} aria-label="Preview recorded voice note"></audio><button type="button" class="remove-audio" onclick={() => updateAudioPreview(null)}>Remove recording</button></div>
					{/if}
					<div class="modal-footer"><span class="private-hint"><span>◈</span> Saved privately on this device</span><div><button type="button" class="cancel-button" onclick={closeEditor}>Cancel</button><button class="primary-button save-button" type="submit">{editingId ? 'Save changes' : 'Save note'}</button></div></div>
				</form>
			</div>
		</div>
	{/if}
</div>

<style>
	:global(*) { box-sizing: border-box; }
	:global(body) { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; background: #f7f8f5; }
	:global(button), :global(input), :global(textarea) { font: inherit; }
	:global(button) { cursor: pointer; }
	.app-shell { --bg: #f7f8f5; --surface: #fff; --text: #25342d; --muted: #839088; --line: #e9ede8; --green: #507b68; --green-dark: #3e6553; --green-soft: #edf4ef; min-height: 100vh; color: var(--text); background: var(--bg); transition: background .25s, color .25s; }
	.app-shell.dark { --bg: #18211d; --surface: #222d27; --text: #edf4ef; --muted: #9aa99f; --line: #354239; --green: #83b198; --green-dark: #a0c6ad; --green-soft: #2a3c31; }
	.sidebar { position: fixed; inset: 0 auto 0 0; z-index: 2; display: flex; flex-direction: column; width: 246px; padding: 30px 18px 20px; background: var(--surface); border-right: 1px solid var(--line); }
	.brand, .mobile-brand { display: flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; }
	.brand { padding: 0 9px; }
	.brand-mark { display: grid; place-items: center; width: 35px; height: 35px; background: var(--green); border-radius: 11px; }
	.brand-mark svg { width: 24px; fill: none; stroke: #f8faf8; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
	.brand-mark.small { width: 30px; height: 30px; border-radius: 9px; }
	.brand-mark.small svg { width: 21px; }
	.brand-name { font: 800 18px 'Segoe UI', system-ui, sans-serif; letter-spacing: -1px; }
	.brand-name span { color: var(--green); }
	.sidebar-rule { height: 1px; margin: 27px 3px 29px; background: var(--line); }
	.eyebrow { margin: 0; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: 1.45px; }
	.sidebar > .eyebrow { padding: 0 11px 12px; }
	.nav-item { display: flex; align-items: center; gap: 13px; width: 100%; min-height: 44px; margin-bottom: 5px; padding: 0 12px; border: 0; border-radius: 9px; color: var(--muted); background: transparent; text-align: left; font-size: 13px; font-weight: 500; transition: background .18s, color .18s; }
	.nav-item:hover, .nav-item.active { color: var(--green-dark); background: var(--green-soft); }
	.nav-item.active { font-weight: 700; }
	.nav-icon { width: 17px; color: var(--green); font-size: 18px; text-align: center; }
	.nav-count { margin-left: auto; padding: 2px 8px; border-radius: 20px; background: rgba(80,123,104,.09); color: var(--green); font-size: 11px; }
	.sidebar-bottom { margin-top: auto; }
	.privacy-card { display: flex; gap: 11px; margin: 0 2px 16px; padding: 14px 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--bg); }
	.privacy-icon { color: var(--green); font-size: 19px; }
	.privacy-card strong { font-size: 11px; }
	.privacy-card p { margin: 4px 0 0; color: var(--muted); font-size: 10px; line-height: 1.5; }
	.theme-button { min-height: 39px; font-size: 12px; }
	.sidebar-foot { display: flex; align-items: center; gap: 8px; padding: 14px 12px 0; color: var(--muted); font-size: 10px; }
	.status-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 100%; background: #74aa83; box-shadow: 0 0 0 3px rgba(116,170,131,.12); }
	.status-dot.offline { background: #d49b54; box-shadow: 0 0 0 3px rgba(212,155,84,.12); }
	.main-content { min-height: 100vh; margin-left: 246px; }
	.topbar { height: 76px; display: flex; align-items: center; justify-content: flex-end; gap: 16px; padding: 0 6.5%; border-bottom: 1px solid var(--line); background: var(--surface); }
	.mobile-brand { display: none; margin-right: auto; }
	.topbar-status { display: flex; align-items: center; gap: 9px; margin-right: 4px; color: var(--muted); font-size: 11px; }
	.topbar-actions { display: flex; align-items: center; gap: 10px; }
	.primary-button { min-height: 40px; padding: 0 17px; border: 0; border-radius: 8px; color: #fff; background: var(--green); font-size: 12px; font-weight: 700; box-shadow: 0 3px 8px rgba(56,93,72,.13); transition: transform .18s, background .18s, box-shadow .18s; }
	.primary-button:hover { transform: translateY(-1px); background: var(--green-dark); box-shadow: 0 5px 12px rgba(56,93,72,.18); }
	.primary-button span { margin-right: 5px; font-size: 17px; vertical-align: -1px; }
	.icon-button { display: none; width: 39px; height: 39px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); background: var(--surface); font-size: 18px; }
	.content { max-width: 1130px; margin: 0 auto; padding: 51px 6.5% 34px; }
	.welcome-row { position: relative; display: flex; align-items: center; justify-content: space-between; min-height: 203px; overflow: hidden; padding: 0 0 30px; border-bottom: 1px solid var(--line); }
	.welcome-row h1 { margin: 14px 0 8px; font: 700 35px/1.23 'Segoe UI', system-ui, sans-serif; letter-spacing: -1.6px; }
	.title-period { color: var(--green); }
	.subtitle { margin: 0; color: var(--muted); font-size: 13px; }
	.mobile-break { display: none; }
	.welcome-illustration { position: relative; width: 220px; height: 160px; margin-right: 30px; }
	.sun-shape { position: absolute; top: 23px; right: 34px; width: 91px; height: 91px; border-radius: 50%; background: #e7eee2; }
	.paper-shape { position: absolute; top: 38px; right: 58px; width: 87px; height: 106px; padding: 32px 16px; transform: rotate(7deg); border: 1px solid #e9e8d9; border-radius: 5px; background: #fcfbf3; box-shadow: 4px 7px 13px rgba(70,91,73,.09); }
	.paper-shape i { display: block; height: 3px; margin: 0 0 10px; border-radius: 3px; background: #bdd0bd; }
	.paper-shape i:nth-child(2) { width: 80%; }.paper-shape i:nth-child(3) { width: 63%; }
	.leaf { position: absolute; width: 41px; height: 17px; border-radius: 100% 0 100% 0; background: #7da88a; }
	.leaf-one { bottom: 17px; right: 100px; transform: rotate(19deg); }
	.leaf-two { bottom: 32px; right: 76px; transform: rotate(-42deg); background: #a4bea0; }
	.sparkle { position: absolute; color: #c1a66d; }.sparkle-one { top: 20px; right: 157px; font-size: 15px; }.sparkle-two { top: 56px; right: 4px; font-size: 13px; }
	.list-toolbar { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 15px 20px; padding: 28px 0 19px; }
	.list-heading { display: flex; align-items: baseline; gap: 11px; white-space: nowrap; }
	.list-heading h2 { margin: 0; font: 700 18px 'Segoe UI', system-ui, sans-serif; letter-spacing: -.55px; }
	.note-count { color: var(--muted); font-size: 11px; }
	.status-sort-row { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.status-tabs { display: inline-flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); }
	.status-tab { display: inline-flex; align-items: center; gap: 7px; min-height: 31px; padding: 0 11px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; font-size: 11px; font-weight: 600; transition: color .18s, background .18s; }
	.status-tab:hover { color: var(--green-dark); }
	.status-tab.active { color: var(--green-dark); background: var(--green-soft); }
	.status-tab span { color: var(--muted); font-size: 9px; }
	.status-tab.active span { color: var(--green); }
	.sort-control { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 10px; }
	.sort-control select { height: 35px; min-width: 132px; padding: 0 26px 0 10px; border: 1px solid var(--line); border-radius: 8px; outline: 0; color: var(--text); background: var(--surface); font-size: 10px; cursor: pointer; }
	.sort-control select:focus { border-color: #9bb8a3; box-shadow: 0 0 0 3px rgba(80,123,104,.08); }
	.toolbar-controls { display: flex; align-items: center; gap: 9px; }
	.search-box { display: flex; align-items: center; width: 242px; height: 37px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); transition: border .18s, box-shadow .18s; }
	.search-box:focus-within { border-color: #9bb8a3; box-shadow: 0 0 0 3px rgba(80,123,104,.08); }
	.search-box svg { width: 15px; flex: 0 0 auto; fill: none; stroke: #94a198; stroke-linecap: round; stroke-width: 1.5; }
	.search-box input { width: 100%; min-width: 0; padding: 0 8px; border: 0; outline: 0; color: var(--text); background: transparent; font-size: 11px; }
	.search-box input::placeholder { color: #a3aca6; }
	.clear-search { border: 0; color: var(--muted); background: none; font-size: 18px; }
	.refresh-button { width: 37px; height: 37px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface); font-size: 20px; transition: transform .3s, color .2s; }
	.refresh-button:hover { transform: rotate(90deg); color: var(--green); }
	.notes-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; }
	.note-card { min-height: 191px; display: flex; flex-direction: column; padding: 17px 18px 13px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); transition: transform .2s, box-shadow .2s, border .2s; animation: rise-in .34s both; }
	.note-card:hover { transform: translateY(-2px); border-color: #d9e3db; box-shadow: 0 8px 23px rgba(44,64,49,.055); }
	.card-topline { display: flex; align-items: center; justify-content: space-between; }
	.note-type { display: inline-flex; align-items: center; gap: 6px; color: #829b85; font-size: 9px; font-weight: 700; letter-spacing: .8px; }
	.note-type > span { font-size: 15px; line-height: 9px; }
	.note-type.voice-badge { color: #c0915d; }
	.card-actions { display: flex; gap: 2px; opacity: .55; transition: opacity .18s; }
	.note-card:hover .card-actions, .card-actions:focus-within { opacity: 1; }
	.card-action { display: grid; place-items: center; width: 29px; height: 29px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; }
	.card-action:hover { color: var(--green); background: var(--green-soft); }
	.card-action svg { width: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.35; }
	.complete-action { border: 1px solid var(--line); }
	.complete-action:hover, .complete-action.complete-action-done { border-color: var(--green); color: var(--green-dark); background: var(--green-soft); }
	.note-card.completed { background: color-mix(in srgb, var(--surface) 92%, var(--green-soft)); }
	.note-card.completed .completed-title { color: var(--muted); text-decoration: line-through; text-decoration-thickness: 1.5px; text-decoration-color: var(--green); }
	.completed-label { display: inline-block; margin-left: 8px; color: var(--green); font: 700 8px 'Segoe UI', system-ui, sans-serif; letter-spacing: .7px; vertical-align: 2px; }
	.card-action.delete-action:hover { color: #c66b61; background: #fbefed; }
	.note-open { display: block; flex: 1; padding: 5px 0 7px; border: 0; color: inherit; background: transparent; text-align: left; }
	.note-open h3 { overflow: hidden; margin: 2px 0 7px; font: 700 15px 'Segoe UI', system-ui, sans-serif; letter-spacing: -.3px; text-overflow: ellipsis; white-space: nowrap; }
	.note-preview { display: -webkit-box; overflow: hidden; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.65; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: pre-wrap; }
	.voice-description { color: #a18e78; font-style: italic; }
	.muted-preview { opacity: .75; font-style: italic; }
	.audio-player { width: 100%; height: 33px; margin: 4px 0 7px; }
	audio { accent-color: var(--green); }
	.card-footer { display: flex; align-items: center; gap: 6px; min-height: 23px; padding-top: 9px; border-top: 1px solid var(--line); color: var(--muted); font-size: 9px; }
	.date-icon { color: #9ba89f; font-size: 14px; }
	.edited-tag { margin-left: auto; color: #a1aaa3; font-size: 8px; font-weight: 700; letter-spacing: .8px; }
	.note-skeleton { height: 191px; padding: 21px 18px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); }
	.skeleton-line, .skeleton-footer { height: 9px; margin-bottom: 13px; border-radius: 8px; background: linear-gradient(90deg, var(--line), rgba(233,237,232,.45), var(--line)); background-size: 200% 100%; animation: shimmer 1.3s infinite; }
	.skeleton-line.short { width: 28%; height: 7px; margin-bottom: 23px; }.skeleton-line.medium { width: 58%; }.skeleton-footer { width: 48%; height: 7px; margin-top: 37px; }
	.empty-state { display: flex; flex-direction: column; align-items: center; min-height: 330px; padding: 39px 20px 22px; text-align: center; animation: rise-in .35s both; }
	.empty-art { position: relative; display: grid; place-items: center; width: 87px; height: 87px; margin-bottom: 12px; border-radius: 50%; background: #edf3ec; }
	.dark .empty-art { background: #2a3c31; }
	.empty-paper { width: 43px; height: 54px; padding: 17px 9px; transform: rotate(-6deg); border: 1px solid #dce5d8; border-radius: 5px; background: #fff; box-shadow: 0 5px 11px rgba(49,80,57,.08); }
	.empty-paper span { display: block; height: 3px; margin-bottom: 5px; border-radius: 2px; background: #c2d3c0; }.empty-paper span:nth-child(2) { width: 77%; }.empty-paper span:nth-child(3) { width: 55%; }
	.empty-art b { position: absolute; top: 10px; right: 10px; color: #c7a86a; font-size: 14px; }
	.empty-state h3 { margin: 9px 0 5px; font: 700 16px 'Segoe UI', system-ui, sans-serif; }
	.empty-state p { margin: 0 0 18px; color: var(--muted); font-size: 11px; line-height: 1.7; }
	.empty-create { min-height: 37px; }
	.search-art { color: var(--green); font-size: 41px; font-weight: 300; }
	.text-button { border: 0; color: var(--green); background: transparent; font-size: 11px; font-weight: 700; }
	.bottom-note { display: flex; justify-content: center; align-items: center; gap: 7px; margin-top: 36px; color: #a0aaa2; font-size: 10px; }
	.bottom-note span { color: #88a78f; font-size: 14px; }
	.mobile-fab { display: none; }
	.toast { position: fixed; right: 25px; bottom: 25px; z-index: 12; display: flex; align-items: center; gap: 10px; max-width: min(420px, calc(100vw - 34px)); padding: 13px 17px; border: 1px solid rgba(255,255,255,.1); border-radius: 10px; color: #f7faf7; background: #304b3c; box-shadow: 0 10px 30px rgba(20,42,28,.22); font-size: 12px; animation: toast-in .2s ease-out; }
	.toast-icon { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; color: #304b3c; background: #bcd5c0; font-size: 12px; font-weight: 700; }
	.modal-backdrop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; overflow-y: auto; padding: 24px; background: rgba(20,32,25,.48); backdrop-filter: blur(4px); animation: fade-in .18s; }
	.editor-modal { width: min(100%, 570px); max-height: calc(100vh - 48px); overflow-y: auto; padding: 27px 30px 20px; border: 1px solid var(--line); border-radius: 15px; background: var(--surface); box-shadow: 0 24px 70px rgba(14,31,20,.2); animation: modal-in .22s ease-out; }
	.modal-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 23px; }
	.modal-header h2 { margin: 6px 0 0; font: 700 22px 'Segoe UI', system-ui, sans-serif; letter-spacing: -.7px; }
	.modal-close { width: 34px; height: 34px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface); font-size: 23px; line-height: 1; }
	.field-label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 9px; font-weight: 700; letter-spacing: 1.05px; }
	.title-input, .editor-modal textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; outline: 0; color: var(--text); background: var(--bg); font-size: 13px; transition: border .18s, box-shadow .18s; }
	.title-input { height: 43px; padding: 0 13px; margin-bottom: 19px; }
	.editor-modal textarea { min-height: 124px; resize: vertical; padding: 13px; line-height: 1.65; }
	.title-input:focus, .editor-modal textarea:focus { border-color: #9bb8a3; box-shadow: 0 0 0 3px rgba(80,123,104,.08); }
	.title-input::placeholder, .editor-modal textarea::placeholder { color: #a6afa8; }
	.content-label { display: flex; justify-content: space-between; }
	.content-label span { color: #a6afa8; font-size: 8px; letter-spacing: .7px; }
	.recording-panel { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 68px; margin-top: 15px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--bg); }
	.recording-copy { display: flex; align-items: center; gap: 10px; min-width: 0; }
	.mic-indicator { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; border-radius: 9px; color: var(--green); background: var(--green-soft); font-size: 18px; }
	.mic-indicator.recording-pulse { color: #fff; background: #c66b61; animation: pulse 1.25s infinite; font-size: 11px; }
	.recording-copy strong, .recording-copy small { display: block; }.recording-copy strong { font-size: 11px; }.recording-copy small { margin-top: 4px; color: var(--muted); font-size: 9px; }
	.record-button { min-width: 69px; height: 31px; border: 1px solid #cfddd1; border-radius: 7px; color: var(--green-dark); background: var(--surface); font-size: 10px; font-weight: 700; }
	.record-button:hover { background: var(--green-soft); }.record-button.recording-button { border-color: #c66b61; color: #fff; background: #c66b61; }
	.waveform { display: flex; align-items: center; gap: 3px; height: 30px; margin-left: auto; }
	.waveform i { width: 2px; height: var(--bar); border-radius: 3px; background: #7ca189; animation: wave .65s ease-in-out infinite alternate; animation-delay: var(--delay); }
	.recording-preview { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
	.recording-preview audio { width: 68%; height: 34px; }.remove-audio { border: 0; color: #be6a61; background: transparent; font-size: 10px; }
	.modal-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 21px; padding-top: 15px; border-top: 1px solid var(--line); }
	.private-hint { color: var(--muted); font-size: 9px; }.private-hint span { margin-right: 4px; color: var(--green); }
	.modal-footer > div { display: flex; gap: 8px; }
	.cancel-button { min-height: 38px; padding: 0 14px; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); background: var(--surface); font-size: 11px; }
	.save-button { min-height: 38px; font-size: 11px; }
	@keyframes shimmer { to { background-position: -200% 0; } }
	@keyframes rise-in { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
	@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
	@keyframes modal-in { from { opacity: 0; transform: translateY(8px) scale(.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
	@keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
	@keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(198,107,97,.16); } }
	@keyframes wave { to { transform: scaleY(.38); } }

	@media (min-width: 1450px) { .content { padding-right: 8%; padding-left: 8%; } }
	@media (max-width: 1050px) {
		.sidebar { width: 215px; }.main-content { margin-left: 215px; }
		.content { padding-right: 5%; padding-left: 5%; }.topbar { padding-right: 5%; }
		.welcome-illustration { margin-right: 4px; }
	}
	@media (max-width: 760px) {
		.sidebar { display: none; }.main-content { margin-left: 0; }
		.topbar { height: 61px; justify-content: space-between; gap: 8px; padding: 0 19px; }
		.mobile-brand { display: flex; }.brand-name { font-size: 16px; }
		.topbar-status { margin-left: auto; margin-right: 4px; font-size: 10px; }.topbar-status .status-dot { width: 6px; height: 6px; }
		.topbar-actions { gap: 7px; }.theme-mobile { display: block; width: 34px; height: 34px; font-size: 16px; }.top-create { display: none; }
		.content { padding: 28px 21px 94px; }
		.welcome-row { min-height: 153px; padding-bottom: 22px; }
		.welcome-row h1 { max-width: 350px; margin: 10px 0 7px; font-size: clamp(27px, 7.1vw, 34px); letter-spacing: -1.4px; }.mobile-break { display: initial; }
		.subtitle { font-size: 11px; }
		.welcome-illustration { position: absolute; right: -40px; bottom: 4px; width: 155px; height: 130px; opacity: .78; transform: scale(.8); transform-origin: bottom right; }
		.list-toolbar { grid-template-columns: 1fr auto; gap: 12px; padding: 21px 0 14px; }
		.list-heading { min-width: 0; }.list-heading h2 { font-size: 17px; }
		.status-sort-row { flex-wrap: wrap; }
		.status-tabs { flex: 1; justify-content: space-between; }
		.status-tab { justify-content: center; flex: 1; gap: 5px; min-height: 34px; padding: 0 7px; font-size: 10px; }
		.sort-control { gap: 6px; }
		.sort-control select { min-width: 117px; height: 37px; }
		.toolbar-controls { width: 100%; }.search-box { flex: 1; width: auto; height: 39px; }.refresh-button { width: 39px; height: 39px; }
		.notes-grid { grid-template-columns: minmax(0, 1fr); gap: 11px; }.note-card { min-height: 166px; padding: 14px 15px 11px; }
		.card-actions { opacity: 1; }.note-open { padding-top: 2px; }.note-open h3 { font-size: 14px; }
		.empty-state { min-height: 310px; padding-top: 40px; }.bottom-note { margin-top: 29px; font-size: 9px; }
		.mobile-fab { position: fixed; right: 20px; bottom: 21px; z-index: 3; display: grid; place-items: center; width: 55px; height: 55px; border: 0; border-radius: 18px; color: white; background: var(--green); box-shadow: 0 7px 18px rgba(44,91,62,.29); font-size: 29px; font-weight: 300; transition: transform .18s; }.mobile-fab:active { transform: scale(.94); }
		.toast { right: 14px; bottom: 88px; left: 14px; width: fit-content; margin: auto; padding: 11px 14px; font-size: 11px; }
		.modal-backdrop { align-items: end; padding: 0; }
		.editor-modal { width: 100%; max-height: min(91vh, 800px); padding: 23px 21px max(18px, env(safe-area-inset-bottom)); border-radius: 18px 18px 0 0; }
		.modal-header { margin-bottom: 20px; }.modal-header h2 { font-size: 20px; }
		.editor-modal textarea { min-height: 110px; }
		.recording-panel { gap: 8px; padding: 9px; }.recording-copy { gap: 8px; }.recording-copy strong { font-size: 10px; }.recording-copy small { font-size: 8px; }
		.waveform { gap: 2px; }.waveform i { width: 2px; }
		.modal-footer { margin-top: 17px; }.private-hint { max-width: 125px; line-height: 1.4; }
	}
	@media (max-width: 360px) {
		.topbar { padding: 0 12px; }.topbar-status { font-size: 9px; gap: 6px; }
		.content { padding-right: 15px; padding-left: 15px; }.brand-name { font-size: 15px; }
		.welcome-illustration { right: -51px; opacity: .62; }
		.status-sort-row { gap: 8px; }
		.status-tab { padding: 0 5px; font-size: 9px; }
		.status-tab span { font-size: 8px; }
		.sort-control > span { display: none; }
		.private-hint { display: none; }.modal-footer { justify-content: flex-end; }
	}
	@media (prefers-reduced-motion: reduce) {
		:global(*), :global(*::before), :global(*::after) { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
	}
</style>

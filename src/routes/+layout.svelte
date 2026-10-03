<script>
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/icons/icon-192.svg" type="image/svg+xml" />
</svelte:head>

{@render children()}

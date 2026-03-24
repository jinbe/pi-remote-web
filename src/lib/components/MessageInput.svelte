<script lang="ts">
	import { hapticLight, hapticMedium } from '$lib/haptics';
	import { uniqueId } from '$lib/utils';
	import Icon from './Icon.svelte';

	interface SlashCommand {
		name: string;
		description?: string;
		source: 'extension' | 'prompt' | 'skill';
	}

	interface AttachedFile {
		id: string;
		name: string;
		mimeType: string;
		data: string; // base64 (compressed)
		preview?: string; // data URL for thumbnail preview
		originalSize: number; // bytes before compression
		compressedSize: number; // bytes after compression
	}

	// --- Image compression constants ---
	const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB raw input limit
	const MAX_DIMENSION = 2048; // max width or height after resize
	const JPEG_QUALITY = 0.85;
	const TARGET_SIZE_BYTES = 1024 * 1024; // target ~1MB per image after compression
	const MIN_JPEG_QUALITY = 0.3;
	const SUPPORTED_IMAGE_TYPES = new Set([
		'image/jpeg', 'image/png', 'image/gif', 'image/webp',
		'image/heic', 'image/heif',   // iPhone default format
		'image/bmp', 'image/tiff',    // legacy formats
	]);
	// Extensions to accept when MIME type is missing or unrecognized
	const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i;

	let {
		sessionId,
		disabled = false,
		streaming = false,
		onsent
	}: {
		sessionId: string;
		disabled?: boolean;
		streaming?: boolean;
		onsent?: (text: string) => void;
	} = $props();

	let message = $state('');
	let sending = $state(false);
	let sendingStatus = $state<string>(''); // status text shown during send
	let sendError = $state<string | null>(null); // error message to display
	let showSendMenu = $state(false);
	let attachedFiles = $state<AttachedFile[]>([]);
	let compressing = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();

	const SEND_TIMEOUT_MS = 45_000; // 45s timeout for send requests

	// Autocomplete state
	let commands = $state<SlashCommand[]>([]);
	let commandsLoadedForSession = $state<string | null>(null);
	let commandsFetching = $state(false);
	let commandsRetryCount = $state(0);
	let showAutocomplete = $state(false);
	let selectedIndex = $state(0);
	let menuRef: HTMLUListElement | undefined = $state();

	const COMMANDS_FETCH_TIMEOUT_MS = 5_000; // short timeout — metadata query, not a long operation
	const COMMANDS_RETRY_DELAY_MS = 1_500; // auto-retry delay when session wasn't ready
	const MAX_COMMANDS_RETRIES = 3;

	const filtered = $derived.by(() => {
		if (!showAutocomplete) return [];
		const input = message.slice(1).toLowerCase();
		return commands.filter((c) => c.name.toLowerCase().startsWith(input));
	});

	// Reset commands when sessionId changes
	$effect(() => {
		// Read sessionId to establish the dependency
		const _id = sessionId;
		commandsLoadedForSession = null;
		commands = [];
		commandsRetryCount = 0;
	});

	// Fetch commands lazily on first /
	// Re-fetches if session changed or previous fetch returned empty (session may not have been ready)
	async function ensureCommands() {
		if (commandsFetching) return;
		if (commandsLoadedForSession === sessionId && commands.length > 0) return;
		commandsFetching = true;
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), COMMANDS_FETCH_TIMEOUT_MS);
			const res = await fetch(`/api/sessions/${sessionId}/commands`, { signal: controller.signal });
			clearTimeout(timeoutId);
			if (res.ok) {
				const data = await res.json();
				const fetched = Array.isArray(data.commands) ? data.commands : [];
				commands = fetched;
				if (fetched.length > 0) {
					commandsLoadedForSession = sessionId;
					commandsRetryCount = 0;
					// Refresh autocomplete now that commands arrived
					updateAutocomplete();
				} else if (commandsRetryCount < MAX_COMMANDS_RETRIES) {
					// Session may not be ready — schedule an automatic retry
					commandsRetryCount++;
					setTimeout(() => {
						// Only retry if still on the same session and still no commands
						if (commandsLoadedForSession !== sessionId) {
							ensureCommands();
						}
					}, COMMANDS_RETRY_DELAY_MS);
				}
			}
		} catch {
			/* ignore — will retry on next / keystroke or via auto-retry */
		} finally {
			commandsFetching = false;
		}
	}

	function updateAutocomplete() {
		if (message.startsWith('/') && !message.includes(' ') && message.length >= 1) {
			showAutocomplete = true;
			selectedIndex = 0;
		} else {
			showAutocomplete = false;
		}
	}

	function acceptCompletion(cmd: SlashCommand) {
		hapticLight();
		message = '/' + cmd.name + ' ';
		showAutocomplete = false;
	}

	// --- Image compression ---

	/**
	 * Check if a file looks like HEIC/HEIF based on type or extension.
	 */
	function isHeic(file: File): boolean {
		const type = file.type.toLowerCase();
		if (type === 'image/heic' || type === 'image/heif') return true;
		return /\.heic$/i.test(file.name) || /\.heif$/i.test(file.name);
	}

	/**
	 * Convert HEIC/HEIF to JPEG blob using heic2any.
	 * This is the fallback for browsers that can't decode HEIC natively.
	 */
	async function convertHeicToJpeg(file: File): Promise<Blob> {
		const { default: heic2any } = await import('heic2any');
		const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
		// heic2any can return a single Blob or an array (for multi-image HEIC)
		return Array.isArray(result) ? result[0] : result;
	}

	/**
	 * Try to load a Blob as an image via <img> element.
	 */
	function loadViaImgElement(blob: Blob): Promise<HTMLImageElement> {
		const objectUrl = URL.createObjectURL(blob);
		return new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => {
				URL.revokeObjectURL(objectUrl);
				// Guard against 0×0 (corrupt/empty image)
				if (el.naturalWidth === 0 || el.naturalHeight === 0) {
					reject(new Error('Image decoded to 0×0'));
				} else {
					resolve(el);
				}
			};
			el.onerror = () => {
				URL.revokeObjectURL(objectUrl);
				reject(new Error('img decode failed'));
			};
			el.src = objectUrl;
		});
	}

	/**
	 * Load a File/Blob into a drawable source for Canvas.
	 * Tries multiple strategies:
	 *   1. createImageBitmap (modern, broadest format support)
	 *   2. <img> element with original file
	 *   3. <img> element with re-typed Blob (fixes broken MIME type)
	 *   4. heic2any JS decoder (HEIC only)
	 */
	async function loadImageFromFile(file: File): Promise<{ bitmap: ImageBitmap | HTMLImageElement; width: number; height: number }> {
		// 1. Try createImageBitmap — broadest native format support
		if (typeof createImageBitmap === 'function') {
			try {
				const bitmap = await createImageBitmap(file);
				return { bitmap, width: bitmap.width, height: bitmap.height };
			} catch {
				// Fall through
			}
		}

		// 2. Try <img> element with original file
		try {
			const img = await loadViaImgElement(file);
			return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight };
		} catch {
			// Fall through
		}

		// 3. Re-read as ArrayBuffer and create a new Blob with explicit MIME type.
		//    This fixes cases where the browser's type detection is wrong/missing
		//    (e.g., phone camera sends `image/jpeg` but the blob has no type internally).
		{
			const mimeGuess = guessMimeType(file);
			if (mimeGuess && mimeGuess !== file.type) {
				const buf = await file.arrayBuffer();
				const retyped = new Blob([buf], { type: mimeGuess });
				try {
					if (typeof createImageBitmap === 'function') {
						const bitmap = await createImageBitmap(retyped);
						return { bitmap, width: bitmap.width, height: bitmap.height };
					}
					const img = await loadViaImgElement(retyped);
					return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight };
				} catch {
					// Fall through
				}
			}
		}

		// 4. Last resort: HEIC → JPEG via heic2any JS decoder
		if (isHeic(file)) {
			const jpegBlob = await convertHeicToJpeg(file);
			try {
				if (typeof createImageBitmap === 'function') {
					const bitmap = await createImageBitmap(jpegBlob);
					return { bitmap, width: bitmap.width, height: bitmap.height };
				}
				const img = await loadViaImgElement(jpegBlob);
				return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight };
			} catch {
				throw new Error('HEIC conversion succeeded but decoded image is invalid');
			}
		}

		throw new Error(`Browser cannot decode this image (type: ${file.type || 'unknown'}, name: ${file.name})`);
	}

	/**
	 * Guess MIME type from file extension when the reported type is missing or wrong.
	 */
	function guessMimeType(file: File): string | null {
		const ext = file.name.split('.').pop()?.toLowerCase();
		const map: Record<string, string> = {
			jpg: 'image/jpeg',
			jpeg: 'image/jpeg',
			png: 'image/png',
			gif: 'image/gif',
			webp: 'image/webp',
			bmp: 'image/bmp',
			heic: 'image/heic',
			heif: 'image/heif',
			tif: 'image/tiff',
			tiff: 'image/tiff',
		};
		return ext ? (map[ext] ?? null) : null;
	}

	/**
	 * Compress an image using Canvas.
	 * - Downscales to MAX_DIMENSION on the longest side
	 * - Converts to JPEG at JPEG_QUALITY
	 * - If still above TARGET_SIZE_BYTES, iteratively reduces quality
	 * - GIFs are passed through uncompressed (animation would be lost)
	 * - HEIC/HEIF are decoded by the browser and re-encoded as JPEG
	 */
	async function compressImage(file: File): Promise<{ data: string; mimeType: string; compressedSize: number }> {
		// Skip compression for GIFs (would lose animation)
		if (file.type === 'image/gif') {
			const data = await fileToBase64Raw(file);
			return { data, mimeType: 'image/gif', compressedSize: file.size };
		}

		const { bitmap, width: origWidth, height: origHeight } = await loadImageFromFile(file);

		// Calculate new dimensions
		let width = origWidth;
		let height = origHeight;
		if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
			const scale = MAX_DIMENSION / Math.max(width, height);
			width = Math.round(width * scale);
			height = Math.round(height * scale);
		}

		// Draw to canvas
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(bitmap, 0, 0, width, height);

		// Close ImageBitmap to free memory
		if ('close' in bitmap) (bitmap as ImageBitmap).close();

		// For PNGs with transparency, keep as PNG but resize
		// For everything else (including HEIC), convert to JPEG
		const hasAlpha = file.type === 'image/png';

		if (hasAlpha) {
			// Try PNG first at the resized dimensions
			const pngDataUrl = canvas.toDataURL('image/png');
			const pngBase64 = pngDataUrl.split(',')[1];
			const pngSize = Math.ceil(pngBase64.length * 3 / 4);

			if (pngSize <= TARGET_SIZE_BYTES) {
				return { data: pngBase64, mimeType: 'image/png', compressedSize: pngSize };
			}
			// PNG too large even after resize — fall through to JPEG
		}

		// Iteratively compress as JPEG until under target size
		let quality = JPEG_QUALITY;
		let base64 = '';
		let size = 0;

		do {
			const dataUrl = canvas.toDataURL('image/jpeg', quality);
			base64 = dataUrl.split(',')[1];
			size = Math.ceil(base64.length * 3 / 4);

			if (size <= TARGET_SIZE_BYTES) break;
			quality -= 0.1;
		} while (quality >= MIN_JPEG_QUALITY);

		return { data: base64, mimeType: 'image/jpeg', compressedSize: size };
	}

	// --- File handling ---

	function handleAttachClick() {
		hapticLight();
		fileInput?.click();
	}

	async function handleFileSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = input.files;
		if (!files) return;

		for (const file of files) {
			await addFile(file);
		}
		// Reset input so the same file can be selected again
		input.value = '';
	}

	function isImageFile(file: File): boolean {
		if (file.type && SUPPORTED_IMAGE_TYPES.has(file.type)) return true;
		if (file.type && file.type.startsWith('image/')) return true;
		// Fall back to extension check when MIME type is missing/generic
		if (IMAGE_EXTENSIONS.test(file.name)) return true;
		return false;
	}

	async function addFile(file: File) {
		if (file.size > MAX_FILE_SIZE_BYTES) {
			alert(`File "${file.name}" is too large (max 20MB)`);
			return;
		}

		if (!isImageFile(file)) {
			alert(`"${file.name}" doesn't appear to be an image. Supported: JPEG, PNG, GIF, WebP, HEIC`);
			return;
		}

		compressing = true;
		try {
			const { data, mimeType, compressedSize } = await compressImage(file);

			// Create a thumbnail preview from the compressed data
			const preview = `data:${mimeType};base64,${data}`;

			attachedFiles = [
				...attachedFiles,
				{
					id: uniqueId(),
					name: file.name,
					mimeType,
					data,
					preview,
					originalSize: file.size,
					compressedSize
				}
			];
			hapticLight();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error('Failed to process image:', file.name, 'type:', file.type, 'size:', file.size, 'error:', err);
			alert(`Failed to process "${file.name}".\n\n${isHeic(file) ? 'HEIC conversion failed — try converting to JPEG in your Photos app first.' : 'The image format may not be supported by your browser.'}\n\n(${detail})`);
		} finally {
			compressing = false;
		}
	}

	function removeFile(id: string) {
		attachedFiles = attachedFiles.filter((f) => f.id !== id);
		hapticLight();
	}

	function fileToBase64Raw(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				resolve(result.split(',')[1]);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	// Handle paste events for images
	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;

		for (const item of items) {
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (file) addFile(file);
				return;
			}
		}
	}

	// Handle drag and drop
	let dragOver = $state(false);

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer?.types.includes('Files')) {
			dragOver = true;
		}
	}

	function handleDragLeave() {
		dragOver = false;
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const files = e.dataTransfer?.files;
		if (!files) return;

		for (const file of files) {
			if (isImageFile(file)) {
				await addFile(file);
			}
		}
	}

	// --- Sending ---

	async function doSend(behavior?: 'steer') {
		if ((!message.trim() && attachedFiles.length === 0) || sending) return;
		hapticMedium();
		sending = true;
		sendError = null;
		showSendMenu = false;

		const sentText = message.trim() || (attachedFiles.length > 0 ? 'What do you see in this image?' : '');

		const images = attachedFiles.map((f) => ({
			type: 'image' as const,
			data: f.data,
			mimeType: f.mimeType
		}));

		const hasImages = images.length > 0;
		sendingStatus = hasImages ? 'Uploading image…' : 'Sending…';

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

			const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: sentText,
					behavior: behavior || undefined,
					images: hasImages ? images : undefined
				}),
				signal: controller.signal
			});

			clearTimeout(timeoutId);

			if (res.ok) {
				onsent?.(sentText);
				message = '';
				attachedFiles = [];
				showAutocomplete = false;
			} else {
				const errorBody = await res.text().catch(() => '');
				const errorMsg = errorBody ? (JSON.parse(errorBody)?.message ?? errorBody).slice(0, 200) : `Server error (${res.status})`;
				sendError = errorMsg;
				console.error('Send failed:', res.status, errorBody);
			}
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				sendError = 'Request timed out — the server may be busy. Try again.';
			} else {
				sendError = `Failed to send: ${err instanceof Error ? err.message : String(err)}`;
			}
			console.error('Send error:', err);
		} finally {
			sending = false;
			sendingStatus = '';
		}
	}

	function handleSend() {
		doSend();
	}

	function handleSteer() {
		doSend('steer');
	}

	function handleKeydown(e: KeyboardEvent) {
		if (showAutocomplete && filtered.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				selectedIndex = (selectedIndex + 1) % filtered.length;
				scrollSelectedIntoView();
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
				scrollSelectedIntoView();
				return;
			}
			if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
				e.preventDefault();
				acceptCompletion(filtered[selectedIndex]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				showAutocomplete = false;
				return;
			}
		}

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	function handleInput() {
		// Clear error when user starts typing again
		if (sendError) sendError = null;
		// Update autocomplete state synchronously so the dropdown appears instantly
		// when commands are already cached
		updateAutocomplete();
		// Fire-and-forget: fetch commands in the background if needed.
		// When they arrive, ensureCommands calls updateAutocomplete() again.
		if (message.startsWith('/')) {
			ensureCommands();
		}
	}

	function scrollSelectedIntoView() {
		requestAnimationFrame(() => {
			menuRef?.querySelector('.bg-base-300')?.scrollIntoView({ block: 'nearest' });
		});
	}

	// Quick commands
	const quickCommands = [
		{ label: 'Continue', message: 'continue' },
		{ label: 'Ship', message: 'ship' },
		{ label: 'Commit no push', message: 'commit no push' },
		{ label: 'Create PR', message: 'create pr' }
	];

	async function sendQuickCommand(text: string) {
		if (sending || disabled) return;
		hapticMedium();
		sending = true;
		showSendMenu = false;
		try {
			const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: text })
			});
			if (res.ok) {
				onsent?.(text);
			}
		} finally {
			sending = false;
		}
	}

	// Source badge color
	function sourceBadge(source: string) {
		switch (source) {
			case 'extension': return 'badge-primary';
			case 'skill': return 'badge-secondary';
			case 'prompt': return 'badge-accent';
			default: return 'badge-ghost';
		}
	}

	// Close send menu on outside click
	function handleWindowClick(e: MouseEvent) {
		if (showSendMenu) {
			const target = e.target as HTMLElement;
			if (!target.closest('.send-menu-container')) {
				showSendMenu = false;
			}
		}
	}

	const canSend = $derived((message.trim() || attachedFiles.length > 0) && !compressing);
</script>

<svelte:window onclick={handleWindowClick} />

<!-- Hidden file input -->
<input
	type="file"
	accept="image/*,.heic,.heif"
	multiple
	class="hidden"
	bind:this={fileInput}
	onchange={handleFileSelected}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="border-t border-base-300 bg-base-200 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] relative"
	class:ring-2={dragOver}
	class:ring-primary={dragOver}
	class:ring-inset={dragOver}
	role="region"
	aria-label="Message input"
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	<!-- Drag overlay -->
	{#if dragOver}
		<div class="absolute inset-0 bg-primary/10 z-10 flex items-center justify-center pointer-events-none rounded">
			<span class="text-primary font-semibold text-sm">Drop image here</span>
		</div>
	{/if}

	<!-- Autocomplete dropdown -->
	{#if showAutocomplete && filtered.length > 0}
		<div class="absolute bottom-full left-3 right-3 mb-1 z-20">
			<ul
				class="menu menu-sm bg-base-100 rounded-box shadow-lg border border-base-300 max-h-52 overflow-y-auto flex-nowrap"
				bind:this={menuRef}
			>
				{#each filtered as cmd, i (cmd.name)}
					<li>
						<button
							class="flex items-center gap-2 {i === selectedIndex ? 'bg-base-300' : ''}"
							onmousedown={(e) => { e.preventDefault(); acceptCompletion(cmd); }}
							onmouseenter={() => (selectedIndex = i)}
						>
							<span class="font-mono text-sm">/{cmd.name}</span>
							<span class="badge badge-xs {sourceBadge(cmd.source)}">{cmd.source}</span>
							{#if cmd.description}
								<span class="text-xs text-base-content-subtle truncate">{cmd.description}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Send error banner -->
	{#if sendError}
		<div class="mx-1 mb-2 px-3 py-2 rounded-lg bg-error/15 text-error text-xs flex items-center gap-2">
			<span class="flex-1">{sendError}</span>
			<button class="btn btn-ghost btn-xs btn-circle" onclick={() => (sendError = null)} aria-label="Dismiss error"><Icon name="close" class="w-3.5 h-3.5" /></button>
		</div>
	{/if}

	<!-- Sending status -->
	{#if sending && sendingStatus}
		<div class="mx-1 mb-2 px-3 py-1.5 rounded-lg bg-base-300/50 text-xs flex items-center gap-2">
			<span class="loading loading-spinner loading-xs"></span>
			<span class="text-base-content-subtle">{sendingStatus}</span>
		</div>
	{/if}

	<!-- Attached files preview -->
	{#if attachedFiles.length > 0 || compressing}
		<div class="flex gap-2 mb-2 overflow-x-auto pb-1 items-end">
			{#each attachedFiles as file (file.id)}
				<div class="relative flex-shrink-0 group">
					{#if file.preview}
						<img
							src={file.preview}
							alt={file.name}
							class="h-16 w-16 object-cover rounded-lg border border-base-300"
						/>
					{:else}
						<div class="h-16 w-16 rounded-lg border border-base-300 bg-base-300 flex items-center justify-center text-xs text-base-content-subtle">
							<Icon name="paperclip" class="w-5 h-5" />
						</div>
					{/if}
					<button
						class="absolute -top-1.5 -right-1.5 btn btn-circle btn-xs btn-error opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
						onclick={() => removeFile(file.id)}
						aria-label="Remove {file.name}"
					>
						<Icon name="close" class="w-3 h-3" />
					</button>
					<div class="absolute bottom-0 left-0 right-0 bg-base-300/80 text-[9px] text-center truncate rounded-b-lg px-1">
						{formatBytes(file.compressedSize)}
						{#if file.compressedSize < file.originalSize}
							<span class="opacity-60">({Math.round((1 - file.compressedSize / file.originalSize) * 100)}% smaller)</span>
						{/if}
					</div>
				</div>
			{/each}
			{#if compressing}
				<div class="h-16 w-16 rounded-lg border border-base-300 bg-base-300/50 flex flex-col items-center justify-center flex-shrink-0">
					<span class="loading loading-spinner loading-xs"></span>
					<span class="text-[9px] text-base-content-subtle mt-1">Compressing</span>
				</div>
			{/if}
		</div>
	{/if}

	<div class="flex gap-2">
		<!-- Attach button -->
		<button
			class="btn btn-ghost btn-sm self-end"
			onclick={handleAttachClick}
			disabled={disabled || compressing}
			aria-label="Attach image"
			title="Attach image (or paste/drop)"
		>
			<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
			</svg>
			{#if attachedFiles.length > 0}
				<span class="badge badge-xs badge-primary">{attachedFiles.length}</span>
			{/if}
		</button>
		<textarea
			class="textarea flex-1 min-h-[3rem] max-h-40 resize-none"
			placeholder="Type a message... (/ for commands)"
			bind:value={message}
			onkeydown={handleKeydown}
			oninput={handleInput}
			onpaste={handlePaste}
			{disabled}
			rows={2}
		></textarea>
		<!-- Send button with dropdown menu -->
		<div class="self-end send-menu-container relative">
			<div class="join join-vertical">
				<button
					class="btn btn-primary btn-sm join-item"
					onclick={handleSend}
					disabled={disabled || !canSend || sending}
				>
					{#if sending}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						<Icon name="enter" class="w-4 h-4" />
					{/if}
				</button>
				<button
					class="btn btn-primary btn-sm btn-outline join-item px-1.5"
					aria-label="Send options"
					onclick={() => (showSendMenu = !showSendMenu)}
					disabled={disabled || sending}
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
						<path d="M6 9l6 6 6-6" />
					</svg>
				</button>
			</div>
			{#if showSendMenu}
				<div class="absolute bottom-full right-0 mb-1 z-30">
					<ul class="menu menu-sm bg-base-100 rounded-box shadow-lg border border-base-300 w-44">
						{#if streaming}
							<li>
								<button onclick={handleSteer} disabled={!canSend}>
									<span class="inline-flex items-center gap-1"><Icon name="bolt" class="w-3.5 h-3.5" /> Steer</span>
									<span class="text-[10px] opacity-50">interrupt</span>
								</button>
							</li>
							<li class="border-b border-base-300"></li>
						{/if}
						{#each quickCommands as cmd (cmd.label)}
							<li>
								<button onclick={() => sendQuickCommand(cmd.message)}>
									{cmd.label}
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	</div>
</div>

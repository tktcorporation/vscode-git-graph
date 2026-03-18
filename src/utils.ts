import { CacheEntry } from './types';

/**
 * Bounded LRU cache with memory size tracking.
 * Evicts least-recently-used entries when maxSize is exceeded.
 */
export class LRUCache<T> {
	private cache = new Map<string, CacheEntry<T>>();
	private currentSize = 0;

	constructor(
		private readonly maxSize: number, // max memory in bytes
		private readonly maxEntries: number = 10000
	) {}

	get(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) { return undefined; }
		// Move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value;
	}

	set(key: string, value: T, size: number): void {
		const existing = this.cache.get(key);
		if (existing) {
			this.currentSize -= existing.size;
			this.cache.delete(key);
		}

		this.currentSize += size;
		this.cache.set(key, { key, value, size, timestamp: Date.now() });

		// Evict until within limits
		while ((this.currentSize > this.maxSize || this.cache.size > this.maxEntries) && this.cache.size > 0) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				const entry = this.cache.get(oldest);
				if (entry) { this.currentSize -= entry.size; }
				this.cache.delete(oldest);
			}
		}
	}

	has(key: string): boolean {
		return this.cache.has(key);
	}

	delete(key: string): void {
		const entry = this.cache.get(key);
		if (entry) {
			this.currentSize -= entry.size;
			this.cache.delete(key);
		}
	}

	clear(): void {
		this.cache.clear();
		this.currentSize = 0;
	}

	get size(): number { return this.cache.size; }
	get memoryUsage(): number { return this.currentSize; }
}

/**
 * Semaphore for limiting concurrent operations.
 */
export class Semaphore {
	private queue: Array<() => void> = [];
	private running = 0;

	constructor(private readonly maxConcurrent: number) {}

	async acquire(): Promise<void> {
		if (this.running < this.maxConcurrent) {
			this.running++;
			return;
		}
		return new Promise<void>(resolve => {
			this.queue.push(resolve);
		});
	}

	release(): void {
		this.running--;
		const next = this.queue.shift();
		if (next) {
			this.running++;
			next();
		}
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}

/**
 * Debounce function that coalesces rapid calls.
 */
export function debounce<T extends (...args: any[]) => any>(
	fn: T,
	delayMs: number
): (...args: Parameters<T>) => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (...args: Parameters<T>) => {
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => {
			timer = undefined;
			fn(...args);
		}, delayMs);
	};
}

/**
 * Estimate the byte size of a string (rough).
 */
export function estimateStringSize(str: string): number {
	return str.length * 2; // JS strings are UTF-16
}

/**
 * Estimate memory size of a commit object.
 */
export function estimateCommitSize(commit: any): number {
	let size = 200; // base object overhead
	size += estimateStringSize(commit.hash || '');
	size += estimateStringSize(commit.message || '');
	size += estimateStringSize(commit.author || '');
	size += estimateStringSize(commit.authorEmail || '');
	if (commit.refs) {
		size += commit.refs.length * 100;
	}
	if (commit.parents) {
		size += commit.parents.length * 82;
	}
	return size;
}

/**
 * Normalize a file path for consistent comparison.
 */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Format a date based on format preference.
 */
export function formatDate(timestamp: number, format: string): string {
	const date = new Date(timestamp * 1000);
	switch (format) {
		case 'Date Only':
			return date.toLocaleDateString();
		case 'Relative':
			return getRelativeTime(timestamp);
		default: // 'Date & Time'
			return date.toLocaleString();
	}
}

function getRelativeTime(timestamp: number): string {
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;
	if (diff < 60) { return 'just now'; }
	if (diff < 3600) { return `${Math.floor(diff / 60)} minutes ago`; }
	if (diff < 86400) { return `${Math.floor(diff / 3600)} hours ago`; }
	if (diff < 2592000) { return `${Math.floor(diff / 86400)} days ago`; }
	if (diff < 31536000) { return `${Math.floor(diff / 2592000)} months ago`; }
	return `${Math.floor(diff / 31536000)} years ago`;
}

/**
 * Disposable helper
 */
export class DisposableCollection {
	private disposables: { dispose(): any }[] = [];

	add<T extends { dispose(): any }>(disposable: T): T {
		this.disposables.push(disposable);
		return disposable;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}
}

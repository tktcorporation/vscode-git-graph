import * as path from 'path';
import { GitCommit, GitBranch, GitStash } from './types';

/**
 * Native Rust accelerator for CPU-bound operations.
 *
 * Provides ~5-10x speedup for:
 * - Git log parsing (string parsing with \x00/\x01 delimiters)
 * - Graph lane computation (branch layout algorithm)
 *
 * Gracefully falls back to TypeScript implementations if the native
 * module is unavailable (unsupported platform, missing binary, etc).
 */

// ---- Native module types ----

interface NativeGitCommit {
	hash: string;
	abbreviatedHash: string;
	parents: string[];
	author: string;
	authorEmail: string;
	authorDate: number;
	committer: string;
	committerEmail: string;
	committerDate: number;
	message: string;
}

interface GraphCommitInput {
	hash: string;
	parents: string[];
}

interface GraphLaneResult {
	lanes: number[][];
	maxLanes: number;
}

interface NativeBranch {
	name: string;
	hash: string;
	current: boolean;
	upstream: string | null;
	remote: string | null;
	refname: string;
}

interface NativeStash {
	hash: string;
	selector: string;
	message: string;
	date: number;
}

interface ParseAndComputeResult {
	commitsJson: string;
	lanes: number[][];
	maxLanes: number;
}

interface NativeModule {
	parseGitLog(raw: string): NativeGitCommit[];
	parseGitLogBuffer(raw: Buffer): NativeGitCommit[];
	parseGitLogJson(raw: string): string;
	parseGitLogBufferJson(raw: Buffer): string;
	computeGraphLanes(commits: GraphCommitInput[]): GraphLaneResult;
	parseAndComputeLanes(raw: string): ParseAndComputeResult;
	parseAndComputeLanesBuffer(raw: Buffer): ParseAndComputeResult;
	parseBranches(raw: string): NativeBranch[];
	parseStashes(raw: string): NativeStash[];
}

// ---- Module loading ----

// Use __non_webpack_require__ when bundled by webpack to avoid "critical dependency" warnings
declare const __non_webpack_require__: typeof require | undefined;
const nativeRequire: typeof require = typeof __non_webpack_require__ !== 'undefined'
	? __non_webpack_require__
	: require;

let nativeModule: NativeModule | null = null;
let loadAttempted = false;

function tryLoadNative(): NativeModule | null {
	if (loadAttempted) {
		return nativeModule;
	}
	loadAttempted = true;

	try {
		// The .node file is copied to the out/ directory during build
		const modulePath = path.join(__dirname, 'fast-git-graph-native.linux-x64-gnu.node');
		nativeModule = nativeRequire(modulePath) as NativeModule;
		console.log('[Fast Git Graph] Native Rust accelerator loaded successfully');
	} catch (e) {
		try {
			// Try relative to native/ directory (dev mode)
			const devPath = path.join(__dirname, '..', 'native', 'fast-git-graph-native.linux-x64-gnu.node');
			nativeModule = nativeRequire(devPath) as NativeModule;
			console.log('[Fast Git Graph] Native Rust accelerator loaded (dev mode)');
		} catch {
			console.log('[Fast Git Graph] Native accelerator unavailable, using TypeScript fallback');
			nativeModule = null;
		}
	}

	return nativeModule;
}

// ---- Public API ----

/**
 * Check if the native accelerator is available.
 */
export function isNativeAvailable(): boolean {
	return tryLoadNative() !== null;
}

/**
 * Parse raw git log output into commit objects.
 * Uses Rust native JSON path if available (avoids napi object creation overhead),
 * falls back to TypeScript.
 */
export function parseGitLog(raw: string): GitCommit[] {
	const native = tryLoadNative();

	if (native) {
		// JSON path is faster for large datasets - avoids napi per-object overhead
		const json = native.parseGitLogJson(raw);
		return JSON.parse(json) as GitCommit[];
	}

	return parseGitLogTS(raw);
}

/**
 * Parse git log AND compute graph lanes in a single native call.
 * This is the fastest path for the full pipeline - eliminates
 * JS↔Rust data transfer for graph computation.
 * Returns null if native module unavailable.
 */
export function parseAndComputeLanes(raw: string): {
	commits: GitCommit[];
	lanes: number[][];
	maxLanes: number;
} | null {
	const native = tryLoadNative();

	if (native) {
		const result = native.parseAndComputeLanes(raw);
		const commits = JSON.parse(result.commitsJson) as GitCommit[];
		return {
			commits,
			lanes: result.lanes,
			maxLanes: result.maxLanes,
		};
	}

	return null;
}

/**
 * Parse raw git log output from a Buffer (zero-copy to Rust).
 */
export function parseGitLogBuffer(raw: Buffer): GitCommit[] {
	const native = tryLoadNative();

	if (native) {
		const json = native.parseGitLogBufferJson(raw);
		return JSON.parse(json) as GitCommit[];
	}

	return parseGitLogTS(raw.toString('utf8'));
}

/**
 * Compute graph lane assignments for commits.
 * Uses Rust native algorithm if available, falls back to TypeScript.
 */
export function computeGraphLanes(commits: Array<{ hash: string; parents: string[] }>): {
	lanes: number[][];
	maxLanes: number;
} {
	const native = tryLoadNative();

	if (native) {
		return native.computeGraphLanes(commits);
	}

	return computeGraphLanesTS(commits);
}

/**
 * Parse for-each-ref output into branch objects.
 */
export function parseBranches(raw: string): GitBranch[] {
	const native = tryLoadNative();

	if (native) {
		return native.parseBranches(raw).map(b => ({
			name: b.name,
			hash: b.hash,
			current: b.current,
			upstream: b.upstream ?? undefined,
			remote: b.remote ?? undefined,
		}));
	}

	return parseBranchesTS(raw);
}

/**
 * Parse stash list output.
 */
export function parseStashes(raw: string): GitStash[] {
	const native = tryLoadNative();

	if (native) {
		return native.parseStashes(raw);
	}

	return parseStashesTS(raw);
}

// ---- TypeScript fallback implementations ----

const FIELD_SEP = '\x00';
const RECORD_SEP = '\x01';

function toGitCommit(nc: NativeGitCommit): GitCommit {
	return {
		hash: nc.hash,
		abbreviatedHash: nc.abbreviatedHash,
		parents: nc.parents,
		author: nc.author,
		authorEmail: nc.authorEmail,
		authorDate: nc.authorDate,
		committer: nc.committer,
		committerEmail: nc.committerEmail,
		committerDate: nc.committerDate,
		message: nc.message,
		refs: [],
	};
}

export function parseGitLogTS(raw: string): GitCommit[] {
	const commits: GitCommit[] = [];
	const records = raw.split(RECORD_SEP);

	for (const record of records) {
		const trimmed = record.trim();
		if (!trimmed) { continue; }

		const fields = trimmed.split(FIELD_SEP);
		if (fields.length < 10) { continue; }

		commits.push({
			hash: fields[0],
			abbreviatedHash: fields[1],
			parents: fields[2] ? fields[2].split(' ') : [],
			author: fields[3],
			authorEmail: fields[4],
			authorDate: parseInt(fields[5], 10) || 0,
			committer: fields[6],
			committerEmail: fields[7],
			committerDate: parseInt(fields[8], 10) || 0,
			message: fields[9],
			refs: [],
		});
	}

	return commits;
}

export function computeGraphLanesTS(
	commits: Array<{ hash: string; parents: string[] }>
): { lanes: number[][]; maxLanes: number } {
	const graphLanes: number[][] = [];
	let maxLanes = 0;
	const activeLanes: (string | null)[] = [];

	for (const commit of commits) {
		const commitLanes: number[] = [];

		let myLane = activeLanes.indexOf(commit.hash);
		if (myLane === -1) {
			myLane = activeLanes.indexOf(null);
			if (myLane === -1) {
				myLane = activeLanes.length;
				activeLanes.push(null);
			}
		}
		commitLanes.push(myLane);

		const parents = commit.parents;
		if (parents.length === 0) {
			activeLanes[myLane] = null;
		} else {
			activeLanes[myLane] = parents[0];
			for (let p = 1; p < parents.length; p++) {
				const parentHash = parents[p];
				let parentLane = activeLanes.indexOf(parentHash);
				if (parentLane === -1) {
					parentLane = activeLanes.indexOf(null);
					if (parentLane === -1) {
						parentLane = activeLanes.length;
						activeLanes.push(null);
					}
					activeLanes[parentLane] = parentHash;
				}
				commitLanes.push(parentLane);
			}
		}

		for (let l = activeLanes.length - 1; l >= 0; l--) {
			if (activeLanes[l] === null && l === activeLanes.length - 1) {
				activeLanes.pop();
			}
		}

		graphLanes.push(commitLanes);
		maxLanes = Math.max(maxLanes, activeLanes.length);
	}

	return { lanes: graphLanes, maxLanes };
}

function parseBranchesTS(raw: string): GitBranch[] {
	const branches: GitBranch[] = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) { continue; }
		const parts = line.split(FIELD_SEP);
		if (parts.length < 5) { continue; }

		const refname = parts[4];
		const isRemote = refname.startsWith('refs/remotes/');
		const name = parts[0];
		if (isRemote && name.endsWith('/HEAD')) { continue; }

		branches.push({
			name,
			hash: parts[1],
			current: parts[2] === '*',
			upstream: parts[3] || undefined,
			remote: isRemote ? name.split('/')[0] : undefined,
		});
	}
	return branches;
}

function parseStashesTS(raw: string): GitStash[] {
	const stashes: GitStash[] = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) { continue; }
		const parts = line.split(FIELD_SEP);
		if (parts.length < 4) { continue; }
		stashes.push({
			hash: parts[0],
			selector: parts[1],
			message: parts[2],
			date: parseInt(parts[3], 10) || 0,
		});
	}
	return stashes;
}

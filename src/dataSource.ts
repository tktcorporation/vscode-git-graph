import { GitService } from './gitService';
import {
	GitCommit, GitRef, GitRefType, GitBranch, GitStash,
	GitFileChange, GitFileChangeType, GraphData, CommitDetailsData, SubmoduleInfo
} from './types';
import { LRUCache, estimateCommitSize } from './utils';

// Delimiters for structured git log parsing
const FIELD_SEP = '\x00';
const RECORD_SEP = '\x01';
const LOG_FORMAT = [
	'%H',   // hash
	'%h',   // abbreviated hash
	'%P',   // parent hashes
	'%an',  // author name
	'%ae',  // author email
	'%at',  // author date (unix)
	'%cn',  // committer name
	'%ce',  // committer email
	'%ct',  // committer date (unix)
	'%s'    // subject
].join(FIELD_SEP) + RECORD_SEP;

/**
 * High-performance data source for git repository data.
 *
 * Key optimizations:
 * - Streaming parse of git log (no full-output buffering)
 * - LRU cache for commit details (bounded memory)
 * - Parallel fetching of branches, stashes, and refs
 * - Incremental loading (pagination)
 */
export class DataSource {
	private commitCache: LRUCache<GitCommit[]>;
	private detailsCache: LRUCache<CommitDetailsData>;

	constructor(private git: GitService) {
		// 50MB cache for commits, 20MB for details
		this.commitCache = new LRUCache<GitCommit[]>(50 * 1024 * 1024);
		this.detailsCache = new LRUCache<CommitDetailsData>(20 * 1024 * 1024);
	}

	/**
	 * Load graph data for a repository. This is the main entry point.
	 * Uses parallel fetching and streaming parsing.
	 */
	async loadGraphData(
		repoPath: string,
		maxCommits: number,
		showCurrentBranch: boolean,
		branchFilter: string | null,
		skip: number = 0
	): Promise<GraphData> {
		try {
			// Fetch branches, stashes, remotes, and commits in parallel
			const [branches, stashes, remotes, head, commits] = await Promise.all([
				this.getBranches(repoPath),
				this.getStashes(repoPath),
				this.getRemotes(repoPath),
				this.getHead(repoPath),
				this.getCommits(repoPath, maxCommits, showCurrentBranch, branchFilter, skip)
			]);

			// Resolve refs to commits
			const refs = await this.resolveRefs(repoPath, branches);
			this.attachRefsToCommits(commits, refs, stashes);

			return {
				commits,
				head,
				branches,
				remotes,
				stashes,
				moreCommitsAvailable: commits.length === maxCommits,
				error: null
			};
		} catch (err: any) {
			return {
				commits: [],
				head: null,
				branches: [],
				remotes: [],
				stashes: [],
				moreCommitsAvailable: false,
				error: err.message || 'Unknown error'
			};
		}
	}

	/**
	 * Stream-parse git log output for memory efficiency.
	 */
	async getCommits(
		repoPath: string,
		maxCommits: number,
		showCurrentBranch: boolean,
		branchFilter: string | null,
		skip: number = 0
	): Promise<GitCommit[]> {
		const args = [
			'log',
			`--format=${LOG_FORMAT}`,
			`--max-count=${maxCommits}`,
		];

		if (skip > 0) {
			args.push(`--skip=${skip}`);
		}

		if (showCurrentBranch) {
			args.push('HEAD');
		} else if (branchFilter) {
			args.push(branchFilter);
		} else {
			args.push('--all');
		}

		args.push('--date-order');

		const commits: GitCommit[] = [];
		let buffer = '';

		await this.git.execStreaming(repoPath, args, (line) => {
			buffer += line + '\n';

			// Process complete records
			const records = buffer.split(RECORD_SEP);
			buffer = records.pop() || ''; // Keep incomplete record

			for (const record of records) {
				const trimmed = record.trim();
				if (!trimmed) { continue; }

				const commit = this.parseCommitRecord(trimmed);
				if (commit) {
					commits.push(commit);
				}
			}
		});

		// Process remaining buffer
		if (buffer.trim()) {
			const commit = this.parseCommitRecord(buffer.trim());
			if (commit) {
				commits.push(commit);
			}
		}

		return commits;
	}

	private parseCommitRecord(record: string): GitCommit | null {
		const fields = record.split(FIELD_SEP);
		if (fields.length < 10) { return null; }

		return {
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
			refs: []
		};
	}

	/**
	 * Get branches with parallel remote/local fetching.
	 */
	async getBranches(repoPath: string): Promise<GitBranch[]> {
		const output = await this.git.exec(repoPath, [
			'branch', '-a', '--format=%(refname:short)%(HEAD)%(objectname:short)%(upstream:short)',
			'--sort=-committerdate'
		]);

		const branches: GitBranch[] = [];
		const sep = '\x00'; // Shouldn't appear, but we use structured format above
		// Actually, let's use for-each-ref for more reliable parsing
		return this.getBranchesViaForEachRef(repoPath);
	}

	private async getBranchesViaForEachRef(repoPath: string): Promise<GitBranch[]> {
		const format = '%(refname:short)' + FIELD_SEP + '%(objectname:short)' + FIELD_SEP +
			'%(HEAD)' + FIELD_SEP + '%(upstream:short)' + FIELD_SEP + '%(refname)';

		const output = await this.git.exec(repoPath, [
			'for-each-ref', `--format=${format}`, '--sort=-committerdate',
			'refs/heads/', 'refs/remotes/'
		]);

		const branches: GitBranch[] = [];
		for (const line of output.split('\n')) {
			if (!line.trim()) { continue; }
			const parts = line.split(FIELD_SEP);
			if (parts.length < 5) { continue; }

			const refname = parts[4];
			const isRemote = refname.startsWith('refs/remotes/');
			const name = parts[0];

			// Skip HEAD pointer in remotes
			if (isRemote && name.endsWith('/HEAD')) { continue; }

			branches.push({
				name: parts[0],
				hash: parts[1],
				current: parts[2] === '*',
				upstream: parts[3] || undefined,
				remote: isRemote ? name.split('/')[0] : undefined,
			});
		}

		return branches;
	}

	async getRemotes(repoPath: string): Promise<string[]> {
		const output = await this.git.exec(repoPath, ['remote']);
		return output.split('\n').filter(r => r.trim().length > 0);
	}

	async getHead(repoPath: string): Promise<string | null> {
		try {
			const output = await this.git.exec(repoPath, ['rev-parse', 'HEAD']);
			return output.trim() || null;
		} catch {
			return null;
		}
	}

	/**
	 * Resolve refs to commit hashes (tags, branches, HEAD).
	 */
	private async resolveRefs(repoPath: string, branches: GitBranch[]): Promise<Map<string, GitRef[]>> {
		const refMap = new Map<string, GitRef[]>();

		// Get tags
		try {
			const tagOutput = await this.git.exec(repoPath, [
				'show-ref', '--tags', '-d'
			]);
			for (const line of tagOutput.split('\n')) {
				if (!line.trim()) { continue; }
				const [hash, refname] = line.trim().split(' ');
				if (!hash || !refname) { continue; }
				const targetHash = hash;
				const tagName = refname.replace('refs/tags/', '').replace('^{}', '');
				const isDereferenced = refname.endsWith('^{}');

				// For annotated tags, prefer the dereferenced (commit) hash
				if (isDereferenced || !refMap.has(targetHash)) {
					const refs = refMap.get(targetHash) || [];
					// Remove non-dereferenced version if exists
					if (isDereferenced) {
						const idx = refs.findIndex(r => r.name === tagName && r.type === GitRefType.Tag);
						if (idx >= 0) { refs.splice(idx, 1); }
					}
					refs.push({ name: tagName, type: GitRefType.Tag });
					refMap.set(targetHash, refs);
				}
			}
		} catch {
			// No tags
		}

		// Map branches
		for (const branch of branches) {
			const fullHash = await this.resolveShortHash(repoPath, branch.hash);
			const refs = refMap.get(fullHash) || [];
			refs.push({
				name: branch.name,
				type: branch.remote ? GitRefType.RemoteBranch : GitRefType.Branch,
				remote: branch.remote
			});
			refMap.set(fullHash, refs);
		}

		// HEAD
		try {
			const headRef = await this.git.exec(repoPath, ['rev-parse', 'HEAD']);
			const headHash = headRef.trim();
			if (headHash) {
				const refs = refMap.get(headHash) || [];
				refs.unshift({ name: 'HEAD', type: GitRefType.Head });
				refMap.set(headHash, refs);
			}
		} catch {
			// Detached or empty repo
		}

		return refMap;
	}

	private async resolveShortHash(repoPath: string, shortHash: string): Promise<string> {
		try {
			const output = await this.git.exec(repoPath, ['rev-parse', shortHash]);
			return output.trim();
		} catch {
			return shortHash;
		}
	}

	private attachRefsToCommits(commits: GitCommit[], refMap: Map<string, GitRef[]>, stashes: GitStash[]): void {
		// Build stash hash set
		const stashHashes = new Set(stashes.map(s => s.hash));

		for (const commit of commits) {
			const refs = refMap.get(commit.hash);
			if (refs) {
				commit.refs = refs;
			}
			if (stashHashes.has(commit.hash)) {
				commit.refs.push({
					name: stashes.find(s => s.hash === commit.hash)?.selector || 'stash',
					type: GitRefType.Stash
				});
			}
		}
	}

	async getStashes(repoPath: string): Promise<GitStash[]> {
		try {
			const format = '%H' + FIELD_SEP + '%gd' + FIELD_SEP + '%gs' + FIELD_SEP + '%at';
			const output = await this.git.exec(repoPath, [
				'stash', 'list', `--format=${format}`
			]);

			const stashes: GitStash[] = [];
			for (const line of output.split('\n')) {
				if (!line.trim()) { continue; }
				const parts = line.split(FIELD_SEP);
				if (parts.length < 4) { continue; }
				stashes.push({
					hash: parts[0],
					selector: parts[1],
					message: parts[2],
					date: parseInt(parts[3], 10) || 0
				});
			}
			return stashes;
		} catch {
			return [];
		}
	}

	/**
	 * Get commit details (body + file changes). Uses cache.
	 */
	async getCommitDetails(repoPath: string, hash: string): Promise<CommitDetailsData> {
		const cacheKey = `${repoPath}:${hash}`;
		const cached = this.detailsCache.get(cacheKey);
		if (cached) { return cached; }

		// Fetch body and file changes in parallel
		const [body, fileChanges] = await Promise.all([
			this.getCommitBody(repoPath, hash),
			this.getCommitFileChanges(repoPath, hash)
		]);

		const details: CommitDetailsData = { hash, body, fileChanges };
		const size = body.length * 2 + fileChanges.length * 200;
		this.detailsCache.set(cacheKey, details, size);

		return details;
	}

	private async getCommitBody(repoPath: string, hash: string): Promise<string> {
		const output = await this.git.exec(repoPath, ['log', '-1', '--format=%b', hash]);
		return output.trim();
	}

	async getCommitFileChanges(repoPath: string, hash: string): Promise<GitFileChange[]> {
		const output = await this.git.exec(repoPath, [
			'diff-tree', '-r', '--no-commit-id', '--name-status', '-z', hash
		]);

		const changes: GitFileChange[] = [];
		const parts = output.split('\0').filter(p => p.length > 0);
		let i = 0;

		while (i < parts.length) {
			const status = parts[i];
			if (!status) { i++; continue; }

			const typeChar = status[0] as string;
			const type = this.parseFileChangeType(typeChar);

			if (typeChar === 'R' || typeChar === 'C') {
				// Rename/Copy: status oldPath newPath
				const oldPath = parts[i + 1] || '';
				const newPath = parts[i + 2] || '';
				changes.push({ oldPath, newPath, type });
				i += 3;
			} else {
				const filePath = parts[i + 1] || '';
				changes.push({ oldPath: filePath, newPath: filePath, type });
				i += 2;
			}
		}

		return changes;
	}

	private parseFileChangeType(char: string): GitFileChangeType {
		switch (char) {
			case 'A': return GitFileChangeType.Added;
			case 'D': return GitFileChangeType.Deleted;
			case 'R': return GitFileChangeType.Renamed;
			case 'C': return GitFileChangeType.Copied;
			case 'U': return GitFileChangeType.Unmerged;
			default: return GitFileChangeType.Modified;
		}
	}

	/**
	 * Get submodules for a repo.
	 */
	async getSubmodules(repoPath: string): Promise<SubmoduleInfo[]> {
		try {
			const output = await this.git.exec(repoPath, [
				'submodule', 'status'
			]);

			const submodules: SubmoduleInfo[] = [];
			for (const line of output.split('\n')) {
				const match = line.match(/^[\s+-]?([0-9a-f]+)\s+(\S+)(?:\s+\((.+)\))?/);
				if (match) {
					submodules.push({
						name: match[2],
						path: match[2],
						url: '',
						hash: match[1],
						loaded: false
					});
				}
			}

			// Get URLs in parallel
			if (submodules.length > 0) {
				const urlPromises = submodules.map(async (sub) => {
					try {
						const url = await this.git.exec(repoPath, [
							'config', '--file', '.gitmodules',
							`submodule.${sub.name}.url`
						]);
						sub.url = url.trim();
					} catch {
						// URL not available
					}
				});
				await Promise.all(urlPromises);
			}

			return submodules;
		} catch {
			return [];
		}
	}

	// --- Git operations ---

	async fetch(repoPath: string, remote?: string, prune: boolean = false): Promise<string> {
		const args = ['fetch'];
		if (prune) { args.push('--prune'); }
		if (remote) { args.push(remote); } else { args.push('--all'); }
		return this.git.exec(repoPath, args, 60000);
	}

	async checkout(repoPath: string, ref: string): Promise<string> {
		return this.git.exec(repoPath, ['checkout', ref]);
	}

	async createBranch(repoPath: string, name: string, startPoint?: string): Promise<string> {
		const args = ['branch', name];
		if (startPoint) { args.push(startPoint); }
		return this.git.exec(repoPath, args);
	}

	async deleteBranch(repoPath: string, name: string, force: boolean = false): Promise<string> {
		return this.git.exec(repoPath, ['branch', force ? '-D' : '-d', name]);
	}

	async createTag(repoPath: string, name: string, hash: string, message?: string): Promise<string> {
		const args = ['tag'];
		if (message) { args.push('-a', name, '-m', message, hash); }
		else { args.push(name, hash); }
		return this.git.exec(repoPath, args);
	}

	async deleteTag(repoPath: string, name: string): Promise<string> {
		return this.git.exec(repoPath, ['tag', '-d', name]);
	}

	async merge(repoPath: string, branch: string, noFF: boolean = false): Promise<string> {
		const args = ['merge'];
		if (noFF) { args.push('--no-ff'); }
		args.push(branch);
		return this.git.exec(repoPath, args);
	}

	async rebase(repoPath: string, onto: string): Promise<string> {
		return this.git.exec(repoPath, ['rebase', onto]);
	}

	async cherryPick(repoPath: string, hash: string): Promise<string> {
		return this.git.exec(repoPath, ['cherry-pick', hash]);
	}

	async revert(repoPath: string, hash: string): Promise<string> {
		return this.git.exec(repoPath, ['revert', hash]);
	}

	async reset(repoPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<string> {
		return this.git.exec(repoPath, ['reset', `--${mode}`, hash]);
	}

	clearCache(): void {
		this.commitCache.clear();
		this.detailsCache.clear();
	}

	dispose(): void {
		this.clearCache();
	}
}

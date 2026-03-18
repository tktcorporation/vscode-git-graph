import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { DataSource } from './dataSource';
import { GitRepoState, SubmoduleInfo } from './types';
import { debounce, normalizePath, DisposableCollection } from './utils';

/**
 * Manages discovery, monitoring, and state of git repositories.
 *
 * Key optimizations:
 * - Debounced file watcher (coalesces rapid filesystem events)
 * - Lazy submodule discovery (only when needed)
 * - Efficient repo change detection via .git/HEAD monitoring
 * - Parallel submodule status checks
 */
export class RepoManager {
	private repos = new Map<string, GitRepoState>();
	private watchers = new DisposableCollection();
	private _onDidChangeRepos = new vscode.EventEmitter<void>();
	readonly onDidChangeRepos = this._onDidChangeRepos.event;
	private _onDidRepoUpdate = new vscode.EventEmitter<string>();
	readonly onDidRepoUpdate = this._onDidRepoUpdate.event;

	private refreshDebounced: () => void;

	constructor(
		private git: GitService,
		private dataSource: DataSource,
		private submoduleMode: 'eager' | 'lazy' | 'disabled'
	) {
		this.refreshDebounced = debounce(() => this.scanWorkspace(), 500);
	}

	async initialize(): Promise<void> {
		await this.scanWorkspace();
		this.setupWatchers();
	}

	/**
	 * Scan all workspace folders for git repos.
	 */
	private async scanWorkspace(): Promise<void> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) { return; }

		const newRepos = new Map<string, GitRepoState>();
		const scanPromises = folders.map(folder => this.scanFolder(folder.uri.fsPath, newRepos));
		await Promise.all(scanPromises);

		this.repos = newRepos;
		this._onDidChangeRepos.fire();
	}

	private async scanFolder(folderPath: string, repoMap: Map<string, GitRepoState>): Promise<void> {
		try {
			// Check if this is a git repo
			const gitDir = await this.git.exec(folderPath, ['rev-parse', '--git-dir'], 5000);
			if (!gitDir.trim()) { return; }

			const toplevel = await this.git.exec(folderPath, ['rev-parse', '--show-toplevel'], 5000);
			const repoPath = normalizePath(toplevel.trim());

			if (repoMap.has(repoPath)) { return; }

			const state = await this.getRepoState(repoPath);
			repoMap.set(repoPath, state);

			// Discover submodules if eager
			if (this.submoduleMode === 'eager' && state.submodules.length > 0) {
				for (const sub of state.submodules) {
					const subPath = normalizePath(path.join(repoPath, sub.path));
					try {
						const subState = await this.getRepoState(subPath);
						subState.isSubmodule = true;
						repoMap.set(subPath, subState);
						sub.loaded = true;
					} catch {
						// Submodule not initialized
					}
				}
			}
		} catch {
			// Not a git repo
		}
	}

	private async getRepoState(repoPath: string): Promise<GitRepoState> {
		// Fetch basic repo info in parallel
		const [head, remotes, submodules] = await Promise.all([
			this.dataSource.getHead(repoPath),
			this.dataSource.getRemotes(repoPath),
			this.submoduleMode !== 'disabled'
				? this.dataSource.getSubmodules(repoPath)
				: Promise.resolve([]),
		]);

		return {
			path: repoPath,
			name: path.basename(repoPath),
			branches: [], // Loaded on demand
			head,
			remotes,
			submodules,
			isSubmodule: false,
		};
	}

	/**
	 * Set up file system watchers for git state changes.
	 * Only watches key files to minimize overhead.
	 */
	private setupWatchers(): void {
		this.watchers.dispose();

		// Watch for .git/HEAD changes (branch switches, commits)
		const headWatcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
		this.watchers.add(headWatcher);
		headWatcher.onDidChange(() => this.onGitStateChange());
		headWatcher.onDidCreate(() => this.onGitStateChange());

		// Watch for ref changes (new branches, tags)
		const refsWatcher = vscode.workspace.createFileSystemWatcher('**/.git/refs/**');
		this.watchers.add(refsWatcher);
		refsWatcher.onDidChange(() => this.onGitStateChange());
		refsWatcher.onDidCreate(() => this.onGitStateChange());
		refsWatcher.onDidDelete(() => this.onGitStateChange());

		// Watch for index changes (staging)
		const indexWatcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
		this.watchers.add(indexWatcher);
		indexWatcher.onDidChange(() => this.onGitStateChange());

		// Watch workspace folder changes
		this.watchers.add(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.refreshDebounced();
			})
		);
	}

	private onGitStateChange(): void {
		// Debounce to coalesce rapid changes (e.g., during rebase)
		this.refreshDebounced();
	}

	/**
	 * Get all discovered repos.
	 */
	getRepos(): GitRepoState[] {
		return Array.from(this.repos.values());
	}

	/**
	 * Get a specific repo by path.
	 */
	getRepo(repoPath: string): GitRepoState | undefined {
		return this.repos.get(normalizePath(repoPath));
	}

	/**
	 * Lazily load a submodule's data.
	 */
	async loadSubmodule(parentPath: string, submodulePath: string): Promise<GitRepoState | null> {
		const fullPath = normalizePath(path.join(parentPath, submodulePath));
		try {
			const state = await this.getRepoState(fullPath);
			state.isSubmodule = true;
			this.repos.set(fullPath, state);

			// Update parent's submodule info
			const parent = this.repos.get(normalizePath(parentPath));
			if (parent) {
				const sub = parent.submodules.find(s => normalizePath(path.join(parentPath, s.path)) === fullPath);
				if (sub) { sub.loaded = true; }
			}

			this._onDidChangeRepos.fire();
			return state;
		} catch {
			return null;
		}
	}

	updateSubmoduleMode(mode: 'eager' | 'lazy' | 'disabled'): void {
		this.submoduleMode = mode;
	}

	async rescan(): Promise<void> {
		await this.scanWorkspace();
	}

	dispose(): void {
		this.watchers.dispose();
		this._onDidChangeRepos.dispose();
		this._onDidRepoUpdate.dispose();
	}
}

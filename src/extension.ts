import * as vscode from 'vscode';
import { GitService } from './gitService';
import { DataSource } from './dataSource';
import { RepoManager } from './repoManager';
import { GraphView } from './graphView';
import { getConfig, onConfigChange } from './config';

let gitService: GitService;
let dataSource: DataSource;
let repoManager: RepoManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const config = getConfig();

	// Initialize services
	gitService = new GitService(config.gitCommandPool);
	dataSource = new DataSource(gitService);
	repoManager = new RepoManager(gitService, dataSource, config.submoduleLoadMode);

	// Initialize repo discovery
	await repoManager.initialize();

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('fast-git-graph.view', () => {
			GraphView.createOrShow(context.extensionUri, dataSource, repoManager, gitService);
		}),

		vscode.commands.registerCommand('fast-git-graph.fetch', async () => {
			const repos = repoManager.getRepos();
			if (repos.length === 0) {
				vscode.window.showWarningMessage('No git repositories found');
				return;
			}

			// Fetch all repos in parallel
			const results = await Promise.allSettled(
				repos.map(repo => dataSource.fetch(repo.path))
			);

			const failures = results.filter(r => r.status === 'rejected');
			if (failures.length > 0) {
				vscode.window.showWarningMessage(`Fetch completed with ${failures.length} error(s)`);
			} else {
				vscode.window.showInformationMessage('Fetch completed');
			}
		})
	);

	// Watch config changes
	context.subscriptions.push(
		onConfigChange((newConfig) => {
			gitService.updateConcurrency(newConfig.gitCommandPool);
			repoManager.updateSubmoduleMode(newConfig.submoduleLoadMode);
		})
	);

	// Cleanup
	context.subscriptions.push({
		dispose() {
			gitService.dispose();
			dataSource.dispose();
			repoManager.dispose();
		}
	});
}

export function deactivate(): void {
	gitService?.dispose();
	dataSource?.dispose();
	repoManager?.dispose();
}

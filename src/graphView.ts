import * as vscode from 'vscode';
import * as path from 'path';
import { DataSource } from './dataSource';
import { RepoManager } from './repoManager';
import { GitService } from './gitService';
import { getConfig } from './config';
import {
	MessageType, RequestMessage, ResponseMessage,
	ExtensionConfig, GraphData
} from './types';

/**
 * Manages the Git Graph webview panel.
 *
 * Key optimizations:
 * - Only sends diff updates to webview (not full data)
 * - Retains webview state across visibility changes
 * - Lazy rendering with virtual scroll support
 */
export class GraphView implements vscode.Disposable {
	private static currentPanel: GraphView | undefined;

	private panel: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];
	private currentRepo: string | null = null;
	private currentData: GraphData | null = null;
	private branchFilter: string | null = null;

	private constructor(
		panel: vscode.WebviewPanel,
		private extensionUri: vscode.Uri,
		private dataSource: DataSource,
		private repoManager: RepoManager,
		private gitService: GitService
	) {
		this.panel = panel;

		// Handle messages from webview
		this.panel.webview.onDidReceiveMessage(
			msg => this.handleMessage(msg),
			null,
			this.disposables
		);

		// Handle panel disposal
		this.panel.onDidDispose(
			() => this.dispose(),
			null,
			this.disposables
		);

		// Watch for repo changes
		this.disposables.push(
			this.repoManager.onDidChangeRepos(() => {
				this.sendRepoList();
				if (this.currentRepo) {
					this.loadAndSendCommits();
				}
			})
		);

		this.panel.webview.html = this.getHtmlForWebview();
	}

	static createOrShow(
		extensionUri: vscode.Uri,
		dataSource: DataSource,
		repoManager: RepoManager,
		gitService: GitService
	): GraphView {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (GraphView.currentPanel) {
			GraphView.currentPanel.panel.reveal(column);
			return GraphView.currentPanel;
		}

		const panel = vscode.window.createWebviewPanel(
			'fastGitGraph',
			'Fast Git Graph',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out'), vscode.Uri.joinPath(extensionUri, 'media')]
			}
		);

		GraphView.currentPanel = new GraphView(panel, extensionUri, dataSource, repoManager, gitService);
		return GraphView.currentPanel;
	}

	private async handleMessage(msg: RequestMessage): Promise<void> {
		const config = getConfig();

		try {
			switch (msg.type) {
				case MessageType.RequestLoadCommits:
					this.currentRepo = msg.data.repo || this.getDefaultRepo();
					this.branchFilter = msg.data.branchFilter || null;
					await this.loadAndSendCommits();
					break;

				case MessageType.RequestLoadMore:
					await this.loadMoreCommits(msg.requestId);
					break;

				case MessageType.RequestCommitDetails:
					if (this.currentRepo) {
						const details = await this.dataSource.getCommitDetails(this.currentRepo, msg.data.hash);
						this.postMessage({ type: MessageType.ResponseCommitDetails, requestId: msg.requestId, data: details });
					}
					break;

				case MessageType.RequestViewDiff: {
					if (!this.currentRepo) { break; }
					const { hash, filePath, oldPath } = msg.data;
					const leftUri = vscode.Uri.parse(`git-graph://authority/${oldPath || filePath}?hash=${hash}~1`);
					const rightUri = vscode.Uri.parse(`git-graph://authority/${filePath}?hash=${hash}`);
					const title = `${path.basename(filePath)} (${hash.substring(0, 7)})`;
					await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
					break;
				}

				case MessageType.RequestFetch:
					if (this.currentRepo) {
						await this.dataSource.fetch(this.currentRepo, msg.data.remote, msg.data.prune);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestCheckout:
					if (this.currentRepo) {
						await this.dataSource.checkout(this.currentRepo, msg.data.ref);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestCreateBranch:
					if (this.currentRepo) {
						await this.dataSource.createBranch(this.currentRepo, msg.data.name, msg.data.startPoint);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestDeleteBranch:
					if (this.currentRepo) {
						await this.dataSource.deleteBranch(this.currentRepo, msg.data.name, msg.data.force);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestCreateTag:
					if (this.currentRepo) {
						await this.dataSource.createTag(this.currentRepo, msg.data.name, msg.data.hash, msg.data.message);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestDeleteTag:
					if (this.currentRepo) {
						await this.dataSource.deleteTag(this.currentRepo, msg.data.name);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestMerge:
					if (this.currentRepo) {
						await this.dataSource.merge(this.currentRepo, msg.data.branch, msg.data.noFF);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestRebase:
					if (this.currentRepo) {
						await this.dataSource.rebase(this.currentRepo, msg.data.onto);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestCherryPick:
					if (this.currentRepo) {
						await this.dataSource.cherryPick(this.currentRepo, msg.data.hash);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestRevert:
					if (this.currentRepo) {
						await this.dataSource.revert(this.currentRepo, msg.data.hash);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestReset:
					if (this.currentRepo) {
						await this.dataSource.reset(this.currentRepo, msg.data.hash, msg.data.mode);
						await this.loadAndSendCommits();
					}
					break;

				case MessageType.RequestCopyHash:
					await vscode.env.clipboard.writeText(msg.data.hash);
					break;

				case MessageType.RequestCopyMessage:
					await vscode.env.clipboard.writeText(msg.data.message);
					break;

				case MessageType.RequestOpenFile:
					if (this.currentRepo) {
						const fileUri = vscode.Uri.file(path.join(this.currentRepo, msg.data.filePath));
						await vscode.commands.executeCommand('vscode.open', fileUri);
					}
					break;

				case MessageType.RequestRescanRepos:
					await this.repoManager.rescan();
					break;

				case MessageType.RequestRepoChange:
					this.currentRepo = msg.data.repo;
					this.branchFilter = null;
					await this.loadAndSendCommits();
					break;

				case MessageType.RequestBranchFilter:
					this.branchFilter = msg.data.branch;
					await this.loadAndSendCommits();
					break;
			}
		} catch (err: any) {
			this.postMessage({
				type: MessageType.ResponseError,
				requestId: msg.requestId,
				data: { message: err.message || 'Unknown error' }
			});
		}
	}

	private async loadAndSendCommits(): Promise<void> {
		if (!this.currentRepo) {
			this.currentRepo = this.getDefaultRepo();
		}
		if (!this.currentRepo) { return; }

		const config = getConfig();
		const data = await this.dataSource.loadGraphData(
			this.currentRepo,
			config.maxCommits,
			config.showCurrentBranchByDefault,
			this.branchFilter
		);

		this.currentData = data;
		this.postMessage({ type: MessageType.ResponseLoadCommits, data });
		this.sendConfig();
		this.sendRepoList();
	}

	private async loadMoreCommits(requestId: number): Promise<void> {
		if (!this.currentRepo || !this.currentData) { return; }

		const config = getConfig();
		const skip = this.currentData.commits.length;
		const moreData = await this.dataSource.loadGraphData(
			this.currentRepo,
			config.maxCommits,
			config.showCurrentBranchByDefault,
			this.branchFilter,
			skip
		);

		this.currentData.commits.push(...moreData.commits);
		this.currentData.moreCommitsAvailable = moreData.moreCommitsAvailable;

		this.postMessage({
			type: MessageType.ResponseLoadMore,
			requestId,
			data: {
				commits: moreData.commits,
				moreCommitsAvailable: moreData.moreCommitsAvailable
			}
		});
	}

	private getDefaultRepo(): string | null {
		const repos = this.repoManager.getRepos();
		return repos.length > 0 ? repos[0].path : null;
	}

	private sendRepoList(): void {
		const repos = this.repoManager.getRepos().map(r => ({
			path: r.path,
			name: r.name,
			isSubmodule: r.isSubmodule
		}));
		this.postMessage({
			type: MessageType.ResponseRepoList,
			data: { repos, currentRepo: this.currentRepo }
		});
	}

	private sendConfig(): void {
		this.postMessage({
			type: MessageType.ResponseConfig,
			data: getConfig()
		});
	}

	private postMessage(msg: ResponseMessage): void {
		this.panel.webview.postMessage(msg);
	}

	private getHtmlForWebview(): string {
		const webview = this.panel.webview;

		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js')
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css')
		);

		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:;">
	<link href="${styleUri}" rel="stylesheet">
	<title>Fast Git Graph</title>
</head>
<body>
	<div id="app">
		<div id="toolbar">
			<div id="toolbar-left">
				<select id="repoSelect" title="Repository"></select>
				<select id="branchSelect" title="Branch filter">
					<option value="">All Branches</option>
				</select>
			</div>
			<div id="toolbar-right">
				<button id="fetchBtn" title="Fetch">Fetch</button>
				<button id="refreshBtn" title="Refresh">Refresh</button>
			</div>
		</div>
		<div id="graph-container">
			<canvas id="graphCanvas"></canvas>
			<div id="commit-list"></div>
		</div>
		<div id="commit-details" class="hidden">
			<div id="details-header">
				<span id="details-title"></span>
				<button id="details-close" title="Close">&times;</button>
			</div>
			<div id="details-body"></div>
			<div id="details-files"></div>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		GraphView.currentPanel = undefined;
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 64; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

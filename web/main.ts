/**
 * Fast Git Graph - Webview Entry Point
 *
 * Key optimizations over original git-graph:
 * - Virtual scrolling: only renders visible commit rows in DOM
 * - Canvas graph: efficient redraw with dirty rect tracking
 * - Batch DOM updates via requestAnimationFrame
 * - Event delegation instead of per-row listeners
 */

// VS Code API
declare function acquireVsCodeApi(): {
	postMessage(msg: any): void;
	getState(): any;
	setState(state: any): void;
};

const vscode = acquireVsCodeApi();

// ---- Types (subset shared with extension) ----
interface GitCommit {
	hash: string;
	abbreviatedHash: string;
	parents: string[];
	author: string;
	authorEmail: string;
	authorDate: number;
	committerDate: number;
	message: string;
	refs: GitRef[];
}

interface GitRef {
	name: string;
	type: number; // GitRefType enum
	remote?: string;
}

interface GraphData {
	commits: GitCommit[];
	head: string | null;
	branches: Array<{ name: string; hash: string; current: boolean; remote?: string }>;
	remotes: string[];
	stashes: Array<{ hash: string; selector: string; message: string }>;
	moreCommitsAvailable: boolean;
	error: string | null;
}

interface ExtensionConfig {
	maxCommits: number;
	graphColours: string[];
	graphStyle: 'rounded' | 'angular';
	dateFormat: 'Date & Time' | 'Date Only' | 'Relative';
	showCurrentBranchByDefault: boolean;
	fetchAvatars: boolean;
	commitDetailsViewLocation: 'Inline' | 'Tab';
}

// Message types
const MSG = {
	RequestLoadCommits: 'requestLoadCommits',
	RequestLoadMore: 'requestLoadMore',
	RequestCommitDetails: 'requestCommitDetails',
	RequestViewDiff: 'requestViewDiff',
	RequestFetch: 'requestFetch',
	RequestCopyHash: 'requestCopyHash',
	RequestCopyMessage: 'requestCopyMessage',
	RequestOpenFile: 'requestOpenFile',
	RequestRepoChange: 'requestRepoChange',
	RequestBranchFilter: 'requestBranchFilter',
	RequestCheckout: 'requestCheckout',
	RequestCreateBranch: 'requestCreateBranch',
	RequestDeleteBranch: 'requestDeleteBranch',
	RequestCreateTag: 'requestCreateTag',
	RequestDeleteTag: 'requestDeleteTag',
	RequestMerge: 'requestMerge',
	RequestCherryPick: 'requestCherryPick',
	RequestRevert: 'requestRevert',
	RequestReset: 'requestReset',
	RequestRescanRepos: 'requestRescanRepos',
	ResponseLoadCommits: 'responseLoadCommits',
	ResponseLoadMore: 'responseLoadMore',
	ResponseCommitDetails: 'responseCommitDetails',
	ResponseRepoList: 'responseRepoList',
	ResponseError: 'responseError',
	ResponseRefresh: 'responseRefresh',
	ResponseConfig: 'responseConfig',
} as const;

// ---- Constants ----
const ROW_HEIGHT = 28;
const GRAPH_COLUMN_WIDTH = 16;
const GRAPH_LEFT_MARGIN = 8;
const OVERSCAN = 10; // Extra rows to render above/below viewport

// ---- State ----
let commits: GitCommit[] = [];
let graphData: GraphData | null = null;
let config: ExtensionConfig | null = null;
let selectedCommitHash: string | null = null;
let graphLanes: number[][] = []; // lane assignments per commit
let maxLanes = 0;
let requestIdCounter = 0;
let loadingMore = false;

// ---- DOM References ----
const commitListEl = document.getElementById('commit-list')!;
const graphCanvas = document.getElementById('graphCanvas') as HTMLCanvasElement;
const ctx = graphCanvas.getContext('2d')!;
const repoSelect = document.getElementById('repoSelect') as HTMLSelectElement;
const branchSelect = document.getElementById('branchSelect') as HTMLSelectElement;
const fetchBtn = document.getElementById('fetchBtn')!;
const refreshBtn = document.getElementById('refreshBtn')!;
const detailsPanel = document.getElementById('commit-details')!;
const detailsTitle = document.getElementById('details-title')!;
const detailsBody = document.getElementById('details-body')!;
const detailsFiles = document.getElementById('details-files')!;
const detailsClose = document.getElementById('details-close')!;
const graphContainer = document.getElementById('graph-container')!;

// ---- Virtual Scroll State ----
let scrollTop = 0;
let viewportHeight = 0;
let renderedRange = { start: 0, end: 0 };

// ============================================================
// GRAPH LANE COMPUTATION
// ============================================================

/**
 * Compute lane assignments for the commit graph.
 * Each commit gets a lane (column), and we track active lanes.
 */
function computeGraphLanes(): void {
	const hashToIndex = new Map<string, number>();
	commits.forEach((c, i) => hashToIndex.set(c.hash, i));

	graphLanes = [];
	maxLanes = 0;

	const activeLanes: (string | null)[] = []; // hash occupying each lane

	for (let i = 0; i < commits.length; i++) {
		const commit = commits[i];
		const commitLanes: number[] = [];

		// Find this commit's lane
		let myLane = activeLanes.indexOf(commit.hash);
		if (myLane === -1) {
			// New lane - find first empty or append
			myLane = activeLanes.indexOf(null);
			if (myLane === -1) {
				myLane = activeLanes.length;
				activeLanes.push(null);
			}
		}

		commitLanes.push(myLane);

		// Process parents
		const parents = commit.parents;
		if (parents.length === 0) {
			// Root commit - free the lane
			activeLanes[myLane] = null;
		} else {
			// First parent continues in this lane
			activeLanes[myLane] = parents[0];

			// Additional parents get new lanes (merge)
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

		// Clean up completed lanes (no future reference)
		for (let l = activeLanes.length - 1; l >= 0; l--) {
			if (activeLanes[l] === null && l === activeLanes.length - 1) {
				activeLanes.pop();
			}
		}

		graphLanes.push(commitLanes);
		maxLanes = Math.max(maxLanes, activeLanes.length);
	}
}

// ============================================================
// CANVAS GRAPH RENDERING
// ============================================================

function getGraphWidth(): number {
	return GRAPH_LEFT_MARGIN + (maxLanes + 1) * GRAPH_COLUMN_WIDTH;
}

function drawGraph(): void {
	const graphWidth = getGraphWidth();
	const totalHeight = commits.length * ROW_HEIGHT;

	// Set canvas size
	const dpr = window.devicePixelRatio || 1;
	graphCanvas.width = graphWidth * dpr;
	graphCanvas.height = totalHeight * dpr;
	graphCanvas.style.width = graphWidth + 'px';
	graphCanvas.style.height = totalHeight + 'px';
	ctx.scale(dpr, dpr);

	ctx.clearRect(0, 0, graphWidth, totalHeight);

	const colours = config?.graphColours || [
		'#0085d9', '#d9008f', '#00d960', '#d98500',
		'#a300d9', '#00d9cc', '#d90000', '#7fd900'
	];
	const isRounded = config?.graphStyle !== 'angular';

	// Only draw visible range + overscan
	const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
	const endRow = Math.min(commits.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

	// Build parent lookup for drawing edges
	const hashToIndex = new Map<string, number>();
	commits.forEach((c, i) => hashToIndex.set(c.hash, i));

	// Draw edges first (behind nodes)
	ctx.lineWidth = 2;

	for (let i = startRow; i < endRow; i++) {
		const commit = commits[i];
		const lanes = graphLanes[i];
		if (!lanes || lanes.length === 0) { continue; }

		const myLane = lanes[0];
		const x = GRAPH_LEFT_MARGIN + myLane * GRAPH_COLUMN_WIDTH + GRAPH_COLUMN_WIDTH / 2;
		const y = i * ROW_HEIGHT + ROW_HEIGHT / 2;
		const colour = colours[myLane % colours.length];

		// Draw edges to parents
		for (let p = 0; p < commit.parents.length; p++) {
			const parentIndex = hashToIndex.get(commit.parents[p]);
			if (parentIndex === undefined) { continue; }

			const parentLanes = graphLanes[parentIndex];
			if (!parentLanes) { continue; }

			const parentLane = parentLanes[0];
			const px = GRAPH_LEFT_MARGIN + parentLane * GRAPH_COLUMN_WIDTH + GRAPH_COLUMN_WIDTH / 2;
			const py = parentIndex * ROW_HEIGHT + ROW_HEIGHT / 2;

			const edgeColour = p === 0 ? colour : colours[(lanes[p + 1] !== undefined ? lanes[p + 1] : parentLane) % colours.length];

			ctx.strokeStyle = edgeColour;
			ctx.beginPath();
			ctx.moveTo(x, y);

			if (x === px) {
				// Straight line
				ctx.lineTo(px, py);
			} else if (isRounded) {
				// Rounded curve
				const midY = y + ROW_HEIGHT;
				ctx.bezierCurveTo(x, midY, px, py - ROW_HEIGHT, px, py);
			} else {
				// Angular
				const midY = (y + py) / 2;
				ctx.lineTo(x, midY);
				ctx.lineTo(px, midY);
				ctx.lineTo(px, py);
			}

			ctx.stroke();
		}
	}

	// Draw nodes (commit dots)
	for (let i = startRow; i < endRow; i++) {
		const lanes = graphLanes[i];
		if (!lanes || lanes.length === 0) { continue; }

		const myLane = lanes[0];
		const x = GRAPH_LEFT_MARGIN + myLane * GRAPH_COLUMN_WIDTH + GRAPH_COLUMN_WIDTH / 2;
		const y = i * ROW_HEIGHT + ROW_HEIGHT / 2;
		const colour = colours[myLane % colours.length];
		const commit = commits[i];
		const isHead = graphData?.head === commit.hash;
		const isMerge = commit.parents.length > 1;

		ctx.beginPath();
		const radius = isHead ? 5 : (isMerge ? 4 : 3.5);
		ctx.arc(x, y, radius, 0, Math.PI * 2);

		if (isHead) {
			ctx.fillStyle = colour;
			ctx.fill();
			ctx.strokeStyle = '#fff';
			ctx.lineWidth = 2;
			ctx.stroke();
			ctx.lineWidth = 2;
		} else if (isMerge) {
			ctx.fillStyle = '#1e1e1e';
			ctx.fill();
			ctx.strokeStyle = colour;
			ctx.lineWidth = 2;
			ctx.stroke();
		} else {
			ctx.fillStyle = colour;
			ctx.fill();
		}
	}
}

// ============================================================
// VIRTUAL SCROLL COMMIT LIST
// ============================================================

function renderCommitList(): void {
	const totalHeight = commits.length * ROW_HEIGHT;
	const graphWidth = getGraphWidth();

	// Calculate visible range
	const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
	const endRow = Math.min(commits.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

	// Skip if range hasn't changed
	if (startRow === renderedRange.start && endRow === renderedRange.end) { return; }
	renderedRange = { start: startRow, end: endRow };

	// Build HTML for visible rows
	const fragments: string[] = [];
	fragments.push(`<div style="height:${totalHeight}px;position:relative;padding-left:${graphWidth}px">`);

	for (let i = startRow; i < endRow; i++) {
		const commit = commits[i];
		const top = i * ROW_HEIGHT;
		const isSelected = commit.hash === selectedCommitHash;
		const isHead = graphData?.head === commit.hash;

		const refs = commit.refs.map(r => {
			const cls = getRefClass(r);
			return `<span class="ref ${cls}" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>`;
		}).join('');

		const dateStr = formatDate(commit.committerDate);

		fragments.push(
			`<div class="commit-row${isSelected ? ' selected' : ''}${isHead ? ' head' : ''}" ` +
			`style="top:${top}px;height:${ROW_HEIGHT}px" ` +
			`data-hash="${commit.hash}" data-index="${i}">` +
			`<span class="commit-graph-spacer" style="width:${graphWidth}px"></span>` +
			`<span class="commit-hash" title="Click to copy">${commit.abbreviatedHash}</span>` +
			refs +
			`<span class="commit-message" title="${escapeHtml(commit.message)}">${escapeHtml(commit.message)}</span>` +
			`<span class="commit-author">${escapeHtml(commit.author)}</span>` +
			`<span class="commit-date">${dateStr}</span>` +
			`</div>`
		);
	}

	// Load more sentinel
	if (graphData?.moreCommitsAvailable) {
		const top = commits.length * ROW_HEIGHT;
		fragments.push(
			`<div class="load-more" style="top:${top}px;height:${ROW_HEIGHT}px">` +
			`<button id="loadMoreBtn">Load More Commits</button></div>`
		);
	}

	fragments.push('</div>');

	commitListEl.innerHTML = fragments.join('');
}

function getRefClass(ref: GitRef): string {
	switch (ref.type) {
		case 0: return 'ref-head';
		case 1: return 'ref-branch';
		case 2: return 'ref-remote';
		case 3: return 'ref-tag';
		case 4: return 'ref-stash';
		default: return '';
	}
}

function formatDate(timestamp: number): string {
	if (!config) { return ''; }
	const date = new Date(timestamp * 1000);
	switch (config.dateFormat) {
		case 'Date Only':
			return date.toLocaleDateString();
		case 'Relative':
			return getRelativeTime(timestamp);
		default:
			return date.toLocaleString();
	}
}

function getRelativeTime(timestamp: number): string {
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;
	if (diff < 60) { return 'just now'; }
	if (diff < 3600) { return `${Math.floor(diff / 60)}m ago`; }
	if (diff < 86400) { return `${Math.floor(diff / 3600)}h ago`; }
	if (diff < 2592000) { return `${Math.floor(diff / 86400)}d ago`; }
	if (diff < 31536000) { return `${Math.floor(diff / 2592000)}mo ago`; }
	return `${Math.floor(diff / 31536000)}y ago`;
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// SCROLL HANDLING
// ============================================================

let rafId: number | null = null;

function onScroll(): void {
	scrollTop = graphContainer.scrollTop;
	if (rafId === null) {
		rafId = requestAnimationFrame(() => {
			rafId = null;
			renderCommitList();
			drawGraph();
			checkLoadMore();
		});
	}
}

function checkLoadMore(): void {
	if (loadingMore || !graphData?.moreCommitsAvailable) { return; }
	const totalHeight = commits.length * ROW_HEIGHT;
	if (scrollTop + viewportHeight > totalHeight - ROW_HEIGHT * 5) {
		loadMore();
	}
}

function loadMore(): void {
	if (loadingMore) { return; }
	loadingMore = true;
	sendMessage(MSG.RequestLoadMore, {});
}

// ============================================================
// EVENT HANDLERS
// ============================================================

// Event delegation for commit list
commitListEl.addEventListener('click', (e) => {
	const target = e.target as HTMLElement;

	// Copy hash
	if (target.classList.contains('commit-hash')) {
		const row = target.closest('.commit-row') as HTMLElement;
		if (row) {
			sendMessage(MSG.RequestCopyHash, { hash: row.dataset.hash });
			// Visual feedback
			target.classList.add('copied');
			setTimeout(() => target.classList.remove('copied'), 1000);
		}
		return;
	}

	// Load more button
	if (target.id === 'loadMoreBtn') {
		loadMore();
		return;
	}

	// Select commit row
	const row = (target.closest('.commit-row') as HTMLElement);
	if (row) {
		selectCommit(row.dataset.hash!);
	}
});

// Context menu
commitListEl.addEventListener('contextmenu', (e) => {
	const target = e.target as HTMLElement;
	const row = target.closest('.commit-row') as HTMLElement;
	if (!row) { return; }

	e.preventDefault();
	showContextMenu(e.clientX, e.clientY, row.dataset.hash!);
});

fetchBtn.addEventListener('click', () => {
	sendMessage(MSG.RequestFetch, { prune: false });
});

refreshBtn.addEventListener('click', () => {
	sendMessage(MSG.RequestLoadCommits, {
		branchFilter: branchSelect.value || null
	});
});

repoSelect.addEventListener('change', () => {
	sendMessage(MSG.RequestRepoChange, { repo: repoSelect.value });
});

branchSelect.addEventListener('change', () => {
	sendMessage(MSG.RequestBranchFilter, {
		branch: branchSelect.value || null
	});
});

detailsClose.addEventListener('click', () => {
	detailsPanel.classList.add('hidden');
	selectedCommitHash = null;
	renderedRange = { start: 0, end: 0 }; // Force re-render
	renderCommitList();
});

graphContainer.addEventListener('scroll', onScroll);

// ============================================================
// COMMIT SELECTION & DETAILS
// ============================================================

function selectCommit(hash: string): void {
	if (selectedCommitHash === hash) {
		// Toggle off
		selectedCommitHash = null;
		detailsPanel.classList.add('hidden');
	} else {
		selectedCommitHash = hash;
		detailsPanel.classList.remove('hidden');

		const commit = commits.find(c => c.hash === hash);
		if (commit) {
			detailsTitle.textContent = `${commit.abbreviatedHash} - ${commit.message}`;
			detailsBody.textContent = 'Loading...';
			detailsFiles.innerHTML = '';

			sendMessage(MSG.RequestCommitDetails, { hash });
		}
	}

	renderedRange = { start: 0, end: 0 }; // Force re-render
	renderCommitList();
}

// ============================================================
// CONTEXT MENU
// ============================================================

let contextMenu: HTMLElement | null = null;

function showContextMenu(x: number, y: number, hash: string): void {
	removeContextMenu();

	const commit = commits.find(c => c.hash === hash);
	if (!commit) { return; }

	const menu = document.createElement('div');
	menu.className = 'context-menu';
	menu.style.left = x + 'px';
	menu.style.top = y + 'px';

	const items: Array<{ label: string; action: () => void; separator?: boolean }> = [
		{ label: 'Copy Commit Hash', action: () => sendMessage(MSG.RequestCopyHash, { hash }) },
		{ label: 'Copy Commit Message', action: () => sendMessage(MSG.RequestCopyMessage, { message: commit.message }) },
		{ label: '', action: () => {}, separator: true },
		{ label: 'Checkout...', action: () => sendMessage(MSG.RequestCheckout, { ref: hash }) },
		{ label: 'Create Branch...', action: () => promptCreateBranch(hash) },
		{ label: 'Create Tag...', action: () => promptCreateTag(hash) },
		{ label: '', action: () => {}, separator: true },
		{ label: 'Cherry Pick', action: () => sendMessage(MSG.RequestCherryPick, { hash }) },
		{ label: 'Revert', action: () => sendMessage(MSG.RequestRevert, { hash }) },
		{ label: 'Reset to Here...', action: () => promptReset(hash) },
	];

	// Add branch-specific items from refs
	const branchRefs = commit.refs.filter(r => r.type === 1);
	if (branchRefs.length > 0) {
		items.push({ label: '', action: () => {}, separator: true });
		for (const ref of branchRefs) {
			items.push({
				label: `Merge "${ref.name}" into current branch`,
				action: () => sendMessage(MSG.RequestMerge, { branch: ref.name, noFF: false })
			});
		}
	}

	for (const item of items) {
		if (item.separator) {
			const sep = document.createElement('div');
			sep.className = 'context-menu-separator';
			menu.appendChild(sep);
		} else {
			const el = document.createElement('div');
			el.className = 'context-menu-item';
			el.textContent = item.label;
			el.addEventListener('click', () => {
				removeContextMenu();
				item.action();
			});
			menu.appendChild(el);
		}
	}

	document.body.appendChild(menu);
	contextMenu = menu;

	// Close on click outside
	setTimeout(() => {
		document.addEventListener('click', removeContextMenu, { once: true });
	}, 0);
}

function removeContextMenu(): void {
	if (contextMenu) {
		contextMenu.remove();
		contextMenu = null;
	}
}

function promptCreateBranch(hash: string): void {
	const name = prompt('Branch name:');
	if (name) {
		sendMessage(MSG.RequestCreateBranch, { name, startPoint: hash });
	}
}

function promptCreateTag(hash: string): void {
	const name = prompt('Tag name:');
	if (name) {
		const message = prompt('Tag message (leave empty for lightweight tag):');
		sendMessage(MSG.RequestCreateTag, { name, hash, message: message || undefined });
	}
}

function promptReset(hash: string): void {
	const mode = prompt('Reset mode (soft/mixed/hard):');
	if (mode && ['soft', 'mixed', 'hard'].includes(mode)) {
		sendMessage(MSG.RequestReset, { hash, mode });
	}
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

function sendMessage(type: string, data: any): void {
	vscode.postMessage({ type, requestId: ++requestIdCounter, data });
}

window.addEventListener('message', (event) => {
	const msg = event.data;

	switch (msg.type) {
		case MSG.ResponseLoadCommits:
			onLoadCommits(msg.data);
			break;

		case MSG.ResponseLoadMore:
			onLoadMore(msg.data);
			break;

		case MSG.ResponseCommitDetails:
			onCommitDetails(msg.data);
			break;

		case MSG.ResponseRepoList:
			onRepoList(msg.data);
			break;

		case MSG.ResponseConfig:
			config = msg.data;
			if (commits.length > 0) {
				renderedRange = { start: 0, end: 0 };
				renderCommitList();
				drawGraph();
			}
			break;

		case MSG.ResponseError:
			onError(msg.data);
			break;

		case MSG.ResponseRefresh:
			sendMessage(MSG.RequestLoadCommits, {
				branchFilter: branchSelect.value || null
			});
			break;
	}
});

function onLoadCommits(data: GraphData): void {
	graphData = data;
	commits = data.commits;

	if (data.error) {
		commitListEl.innerHTML = `<div class="error-message">${escapeHtml(data.error)}</div>`;
		return;
	}

	// Update branch select
	updateBranchSelect(data.branches);

	// Compute graph layout
	computeGraphLanes();

	// Reset scroll and render
	scrollTop = 0;
	graphContainer.scrollTop = 0;
	viewportHeight = graphContainer.clientHeight;
	renderedRange = { start: 0, end: 0 };

	renderCommitList();
	drawGraph();
}

function onLoadMore(data: { commits: GitCommit[]; moreCommitsAvailable: boolean }): void {
	loadingMore = false;
	if (!graphData) { return; }

	commits.push(...data.commits);
	graphData.commits = commits;
	graphData.moreCommitsAvailable = data.moreCommitsAvailable;

	// Recompute graph lanes with new data
	computeGraphLanes();

	renderedRange = { start: 0, end: 0 };
	renderCommitList();
	drawGraph();
}

function onCommitDetails(data: { hash: string; body: string; fileChanges: Array<{ oldPath: string; newPath: string; type: string }> }): void {
	if (data.hash !== selectedCommitHash) { return; }

	detailsBody.textContent = data.body || '(no body)';

	const filesHtml = data.fileChanges.map(f => {
		const icon = getFileChangeIcon(f.type);
		const displayPath = f.type === 'R' ? `${f.oldPath} → ${f.newPath}` : f.newPath;
		return `<div class="file-change" data-path="${escapeHtml(f.newPath)}" data-old-path="${escapeHtml(f.oldPath)}" data-hash="${data.hash}">` +
			`<span class="file-change-icon ${f.type.toLowerCase()}">${icon}</span>` +
			`<span class="file-change-path">${escapeHtml(displayPath)}</span>` +
			`</div>`;
	}).join('');

	detailsFiles.innerHTML = filesHtml;

	// Event delegation for file clicks
	detailsFiles.onclick = (e) => {
		const fileEl = (e.target as HTMLElement).closest('.file-change') as HTMLElement;
		if (fileEl) {
			sendMessage(MSG.RequestViewDiff, {
				hash: fileEl.dataset.hash,
				filePath: fileEl.dataset.path,
				oldPath: fileEl.dataset.oldPath
			});
		}
	};
}

function onRepoList(data: { repos: Array<{ path: string; name: string; isSubmodule: boolean }>; currentRepo: string | null }): void {
	repoSelect.innerHTML = data.repos.map(r =>
		`<option value="${escapeHtml(r.path)}"${r.path === data.currentRepo ? ' selected' : ''}>${escapeHtml(r.name)}${r.isSubmodule ? ' (submodule)' : ''}</option>`
	).join('');
}

function updateBranchSelect(branches: Array<{ name: string; current: boolean; remote?: string }>): void {
	const currentFilter = branchSelect.value;
	branchSelect.innerHTML = '<option value="">All Branches</option>' +
		branches.map(b =>
			`<option value="${escapeHtml(b.name)}"${b.name === currentFilter ? ' selected' : ''}>${escapeHtml(b.name)}${b.current ? ' *' : ''}</option>`
		).join('');
}

function onError(data: { message: string }): void {
	console.error('Fast Git Graph error:', data.message);
}

function getFileChangeIcon(type: string): string {
	switch (type) {
		case 'A': return '+';
		case 'D': return '-';
		case 'M': return '~';
		case 'R': return '→';
		case 'C': return '⊕';
		default: return '?';
	}
}

// ============================================================
// INITIALIZATION & RESIZE
// ============================================================

function init(): void {
	viewportHeight = graphContainer.clientHeight;

	// Restore state
	const savedState = vscode.getState();
	if (savedState?.selectedCommitHash) {
		selectedCommitHash = savedState.selectedCommitHash;
	}

	// Request initial data
	sendMessage(MSG.RequestLoadCommits, {});
}

// Handle resize
let resizeRaf: number | null = null;
window.addEventListener('resize', () => {
	if (resizeRaf === null) {
		resizeRaf = requestAnimationFrame(() => {
			resizeRaf = null;
			viewportHeight = graphContainer.clientHeight;
			renderedRange = { start: 0, end: 0 };
			renderCommitList();
			drawGraph();
		});
	}
});

// Save state before unload
window.addEventListener('beforeunload', () => {
	vscode.setState({ selectedCommitHash });
});

// Keyboard navigation
document.addEventListener('keydown', (e) => {
	if (!selectedCommitHash) { return; }
	const currentIndex = commits.findIndex(c => c.hash === selectedCommitHash);
	if (currentIndex === -1) { return; }

	if (e.key === 'ArrowDown' && currentIndex < commits.length - 1) {
		e.preventDefault();
		selectCommit(commits[currentIndex + 1].hash);
		ensureVisible(currentIndex + 1);
	} else if (e.key === 'ArrowUp' && currentIndex > 0) {
		e.preventDefault();
		selectCommit(commits[currentIndex - 1].hash);
		ensureVisible(currentIndex - 1);
	} else if (e.key === 'Escape') {
		selectedCommitHash = null;
		detailsPanel.classList.add('hidden');
		renderedRange = { start: 0, end: 0 };
		renderCommitList();
	}
});

function ensureVisible(index: number): void {
	const top = index * ROW_HEIGHT;
	const bottom = top + ROW_HEIGHT;

	if (top < scrollTop) {
		graphContainer.scrollTop = top;
	} else if (bottom > scrollTop + viewportHeight) {
		graphContainer.scrollTop = bottom - viewportHeight;
	}
}

// Start
init();

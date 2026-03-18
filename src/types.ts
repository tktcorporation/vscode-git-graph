// Core types for Fast Git Graph

export interface GitCommit {
	hash: string;
	abbreviatedHash: string;
	parents: string[];
	author: string;
	authorEmail: string;
	authorDate: number; // unix timestamp
	committer: string;
	committerEmail: string;
	committerDate: number;
	message: string;
	refs: GitRef[];
}

export interface GitRef {
	name: string;
	type: GitRefType;
	remote?: string;
}

export const enum GitRefType {
	Head = 0,
	Branch = 1,
	RemoteBranch = 2,
	Tag = 3,
	Stash = 4
}

export interface GitBranch {
	name: string;
	remote?: string;
	current: boolean;
	upstream?: string;
	hash: string;
}

export interface GitStash {
	hash: string;
	selector: string;
	message: string;
	date: number;
}

export interface GitFileChange {
	oldPath: string;
	newPath: string;
	type: GitFileChangeType;
	additions?: number;
	deletions?: number;
}

export const enum GitFileChangeType {
	Added = 'A',
	Modified = 'M',
	Deleted = 'D',
	Renamed = 'R',
	Copied = 'C',
	Unmerged = 'U'
}

export interface GitRepoState {
	path: string;
	name: string;
	branches: GitBranch[];
	head: string | null;
	remotes: string[];
	submodules: SubmoduleInfo[];
	isSubmodule: boolean;
}

export interface SubmoduleInfo {
	name: string;
	path: string;
	url: string;
	hash: string;
	loaded: boolean;
}

export interface GraphData {
	commits: GitCommit[];
	head: string | null;
	branches: GitBranch[];
	remotes: string[];
	stashes: GitStash[];
	moreCommitsAvailable: boolean;
	error: string | null;
	/** Pre-computed graph lanes (from Rust native module). If present, webview skips computation. */
	graphLanes?: number[][];
	/** Maximum active lanes for the pre-computed graph. */
	maxLanes?: number;
}

// Message protocol between extension and webview
export const enum MessageType {
	// Webview -> Extension
	RequestLoadCommits = 'requestLoadCommits',
	RequestLoadMore = 'requestLoadMore',
	RequestCommitDetails = 'requestCommitDetails',
	RequestFileChanges = 'requestFileChanges',
	RequestViewDiff = 'requestViewDiff',
	RequestFetch = 'requestFetch',
	RequestCheckout = 'requestCheckout',
	RequestCreateBranch = 'requestCreateBranch',
	RequestDeleteBranch = 'requestDeleteBranch',
	RequestCreateTag = 'requestCreateTag',
	RequestDeleteTag = 'requestDeleteTag',
	RequestMerge = 'requestMerge',
	RequestRebase = 'requestRebase',
	RequestCherryPick = 'requestCherryPick',
	RequestRevert = 'requestRevert',
	RequestReset = 'requestReset',
	RequestCopyHash = 'requestCopyHash',
	RequestCopyMessage = 'requestCopyMessage',
	RequestOpenFile = 'requestOpenFile',
	RequestRescanRepos = 'requestRescanRepos',
	RequestRepoChange = 'requestRepoChange',
	RequestBranchFilter = 'requestBranchFilter',

	// Extension -> Webview
	ResponseLoadCommits = 'responseLoadCommits',
	ResponseLoadMore = 'responseLoadMore',
	ResponseCommitDetails = 'responseCommitDetails',
	ResponseFileChanges = 'responseFileChanges',
	ResponseRepoList = 'responseRepoList',
	ResponseError = 'responseError',
	ResponseRefresh = 'responseRefresh',
	ResponseConfig = 'responseConfig',
}

export interface RequestMessage {
	type: MessageType;
	requestId: number;
	data: any;
}

export interface ResponseMessage {
	type: MessageType;
	requestId?: number;
	data: any;
}

export interface CommitDetailsData {
	hash: string;
	body: string;
	fileChanges: GitFileChange[];
}

export interface ExtensionConfig {
	maxCommits: number;
	graphColours: string[];
	graphStyle: 'rounded' | 'angular';
	dateFormat: 'Date & Time' | 'Date Only' | 'Relative';
	showCurrentBranchByDefault: boolean;
	fetchAvatars: boolean;
	commitDetailsViewLocation: 'Inline' | 'Tab';
	gitCommandPool: number;
	submoduleLoadMode: 'eager' | 'lazy' | 'disabled';
}

// LRU Cache entry
export interface CacheEntry<T> {
	key: string;
	value: T;
	size: number; // approximate memory size in bytes
	timestamp: number;
}

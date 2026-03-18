import * as vscode from 'vscode';
import { ExtensionConfig } from './types';

const SECTION = 'fast-git-graph';

export function getConfig(): ExtensionConfig {
	const cfg = vscode.workspace.getConfiguration(SECTION);
	return {
		maxCommits: cfg.get<number>('maxCommits', 500),
		graphColours: cfg.get<string[]>('graph.colours', [
			'#0085d9', '#d9008f', '#00d960', '#d98500',
			'#a300d9', '#00d9cc', '#d90000', '#7fd900'
		]),
		graphStyle: cfg.get<'rounded' | 'angular'>('graph.style', 'rounded'),
		dateFormat: cfg.get<'Date & Time' | 'Date Only' | 'Relative'>('dateFormat', 'Date & Time'),
		showCurrentBranchByDefault: cfg.get<boolean>('showCurrentBranchByDefault', false),
		fetchAvatars: cfg.get<boolean>('fetchAvatars', false),
		commitDetailsViewLocation: cfg.get<'Inline' | 'Tab'>('commitDetailsViewLocation', 'Inline'),
		gitCommandPool: cfg.get<number>('gitCommandPool', 8),
		submoduleLoadMode: cfg.get<'eager' | 'lazy' | 'disabled'>('submoduleLoadMode', 'lazy'),
	};
}

export function onConfigChange(callback: (config: ExtensionConfig) => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(SECTION)) {
			callback(getConfig());
		}
	});
}

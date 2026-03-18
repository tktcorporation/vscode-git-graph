import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Semaphore } from './utils';

/**
 * High-performance Git command execution service.
 *
 * Key optimizations:
 * - Command pool with configurable concurrency (Semaphore)
 * - Streaming output parsing for large results
 * - Abort support for cancellable operations
 * - Minimal memory allocation via buffer reuse
 */
export class GitService {
	private gitPath: string = 'git';
	private semaphore: Semaphore;
	private activeProcesses = new Set<cp.ChildProcess>();

	constructor(maxConcurrent: number = 8) {
		this.semaphore = new Semaphore(maxConcurrent);
		this.detectGitPath();
	}

	private async detectGitPath(): Promise<void> {
		const gitConfig = vscode.workspace.getConfiguration('git');
		const configPath = gitConfig.get<string>('path');
		if (configPath) {
			this.gitPath = configPath;
			return;
		}
		// Try to find git in PATH
		try {
			const result = await this.execRaw('.', ['--version'], 5000);
			if (result.exitCode === 0) { return; }
		} catch {
			// Fall through to default
		}
	}

	updateConcurrency(maxConcurrent: number): void {
		this.semaphore = new Semaphore(maxConcurrent);
	}

	/**
	 * Execute a git command with pooling. Returns stdout as string.
	 */
	async exec(cwd: string, args: string[], timeoutMs: number = 30000): Promise<string> {
		return this.semaphore.run(async () => {
			const result = await this.execRaw(cwd, args, timeoutMs);
			return result.stdout;
		});
	}

	/**
	 * Execute a git command and stream output line by line.
	 * Much more memory efficient for large outputs (e.g., git log with many commits).
	 */
	async execStreaming(
		cwd: string,
		args: string[],
		onLine: (line: string) => void,
		timeoutMs: number = 60000
	): Promise<{ exitCode: number; stderr: string }> {
		return this.semaphore.run(() => new Promise((resolve, reject) => {
			const proc = cp.spawn(this.gitPath, args, {
				cwd,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
				stdio: ['ignore', 'pipe', 'pipe']
			});

			this.activeProcesses.add(proc);

			let stderr = '';
			let remainder = '';
			const timeout = setTimeout(() => {
				proc.kill('SIGTERM');
				reject(new Error(`Git command timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			proc.stdout!.setEncoding('utf8');
			proc.stdout!.on('data', (chunk: string) => {
				const data = remainder + chunk;
				const lines = data.split('\n');
				remainder = lines.pop() || '';
				for (const line of lines) {
					onLine(line);
				}
			});

			proc.stderr!.setEncoding('utf8');
			proc.stderr!.on('data', (chunk: string) => {
				stderr += chunk;
			});

			proc.on('close', (code) => {
				clearTimeout(timeout);
				this.activeProcesses.delete(proc);
				if (remainder) { onLine(remainder); }
				resolve({ exitCode: code ?? 1, stderr });
			});

			proc.on('error', (err) => {
				clearTimeout(timeout);
				this.activeProcesses.delete(proc);
				reject(err);
			});
		}));
	}

	/**
	 * Execute multiple git commands in parallel (within pool limits).
	 */
	async execParallel(commands: Array<{ cwd: string; args: string[] }>): Promise<string[]> {
		return Promise.all(commands.map(cmd => this.exec(cmd.cwd, cmd.args)));
	}

	/**
	 * Raw execution without semaphore (internal use).
	 */
	private execRaw(cwd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			const proc = cp.spawn(this.gitPath, args, {
				cwd,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
				stdio: ['ignore', 'pipe', 'pipe']
			});

			this.activeProcesses.add(proc);

			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			let totalStdoutLen = 0;

			const timeout = setTimeout(() => {
				proc.kill('SIGTERM');
				reject(new Error(`Git command timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			proc.stdout!.on('data', (chunk: Buffer) => {
				stdoutChunks.push(chunk);
				totalStdoutLen += chunk.length;
			});

			proc.stderr!.on('data', (chunk: Buffer) => {
				stderrChunks.push(chunk);
			});

			proc.on('close', (code) => {
				clearTimeout(timeout);
				this.activeProcesses.delete(proc);
				resolve({
					stdout: Buffer.concat(stdoutChunks, totalStdoutLen).toString('utf8'),
					stderr: Buffer.concat(stderrChunks).toString('utf8'),
					exitCode: code ?? 1
				});
			});

			proc.on('error', (err) => {
				clearTimeout(timeout);
				this.activeProcesses.delete(proc);
				reject(err);
			});
		});
	}

	/**
	 * Kill all active processes (for cleanup).
	 */
	killAll(): void {
		for (const proc of this.activeProcesses) {
			proc.kill('SIGTERM');
		}
		this.activeProcesses.clear();
	}

	dispose(): void {
		this.killAll();
	}
}

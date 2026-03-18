#!/usr/bin/env node
/**
 * Test runner for Fast Git Graph native accelerator and TypeScript fallbacks.
 * Run with: node tests/run.js
 *
 * Tests both the native Rust module (if available) and the TypeScript
 * fallback implementations to ensure they produce identical results.
 */

'use strict';

const path = require('path');
const assert = require('assert');

// ---- Test framework ----

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function describe(name, fn) {
	console.log(`\n  ${name}`);
	fn();
}

function it(name, fn) {
	totalTests++;
	try {
		fn();
		passedTests++;
		console.log(`    \x1b[32m✓\x1b[0m ${name}`);
	} catch (err) {
		failedTests++;
		console.log(`    \x1b[31m✗\x1b[0m ${name}`);
		console.log(`      \x1b[31m${err.message}\x1b[0m`);
		failures.push({ name, error: err });
	}
}

function deepEqual(actual, expected, msg) {
	assert.deepStrictEqual(actual, expected, msg);
}

function equal(actual, expected, msg) {
	assert.strictEqual(actual, expected, msg);
}

function ok(value, msg) {
	assert.ok(value, msg);
}

// ---- Load modules ----

let nativeModule = null;
try {
	// Try out/ directory first (production build)
	nativeModule = require(path.join(__dirname, '..', 'native', 'fast-git-graph-native.linux-x64-gnu.node'));
	console.log('Native module loaded from native/');
} catch (e) {
	try {
		nativeModule = require(path.join(__dirname, '..', 'out', 'fast-git-graph-native.linux-x64-gnu.node'));
		console.log('Native module loaded from out/');
	} catch (e2) {
		console.log('Native module not available, testing TS fallbacks only');
	}
}

// We need the TS fallbacks from the compiled output
// Build the TS source first if needed, or use require to load from source
// For simplicity, we'll implement the TS fallback functions inline here
// (matching the logic in nativeAccelerator.ts)

const FIELD_SEP = '\x00';
const RECORD_SEP = '\x01';

function parseGitLogTS(raw) {
	const commits = [];
	const records = raw.split(RECORD_SEP);
	for (const record of records) {
		const trimmed = record.trim();
		if (!trimmed) continue;
		const fields = trimmed.split(FIELD_SEP);
		if (fields.length < 10) continue;
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

function computeGraphLanesTS(commits) {
	const graphLanes = [];
	let maxLanes = 0;
	const activeLanes = [];

	for (const commit of commits) {
		const commitLanes = [];
		let myLane = activeLanes.indexOf(commit.hash);
		if (myLane === -1) {
			myLane = activeLanes.indexOf(null);
			if (myLane === -1) {
				myLane = activeLanes.length;
				activeLanes.push(null);
			}
		}
		commitLanes.push(myLane);

		if (commit.parents.length === 0) {
			activeLanes[myLane] = null;
		} else {
			activeLanes[myLane] = commit.parents[0];
			for (let p = 1; p < commit.parents.length; p++) {
				const parentHash = commit.parents[p];
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

// ---- Test data helpers ----

function makeRecord(fields) {
	return fields.join(FIELD_SEP);
}

function makeLog(records) {
	return records.join(RECORD_SEP);
}

function makeCommit(hash, parents, author, date, message) {
	return makeRecord([
		hash,
		hash.substring(0, 7),
		parents.join(' '),
		author || 'Test Author',
		(author || 'test') + '@example.com',
		String(date || 1700000000),
		author || 'Test Author',
		(author || 'test') + '@example.com',
		String(date || 1700000000),
		message || 'test commit'
	]);
}

// ============================================================
// TESTS
// ============================================================

console.log('\nFast Git Graph - Test Suite');
console.log('==========================');

// ---- Parse tests (TS fallback) ----

describe('parseGitLogTS', () => {
	it('should parse a single commit', () => {
		const raw = makeCommit('abc123def456abc123def456abc123def456abc123', [], 'Alice', 1700000000, 'Initial commit');
		const commits = parseGitLogTS(raw);
		equal(commits.length, 1);
		equal(commits[0].hash, 'abc123def456abc123def456abc123def456abc123');
		equal(commits[0].abbreviatedHash, 'abc123d');
		deepEqual(commits[0].parents, []);
		equal(commits[0].author, 'Alice');
		equal(commits[0].authorDate, 1700000000);
		equal(commits[0].message, 'Initial commit');
	});

	it('should parse multiple commits', () => {
		const raw = makeLog([
			makeCommit('hash2222222222222222222222222222222222222222', ['hash1111111111111111111111111111111111111111'], 'Bob', 1700000100, 'second'),
			makeCommit('hash1111111111111111111111111111111111111111', [], 'Alice', 1700000000, 'first'),
		]);
		const commits = parseGitLogTS(raw);
		equal(commits.length, 2);
		equal(commits[0].message, 'second');
		equal(commits[1].message, 'first');
		deepEqual(commits[0].parents, ['hash1111111111111111111111111111111111111111']);
	});

	it('should handle empty input', () => {
		deepEqual(parseGitLogTS(''), []);
	});

	it('should skip malformed records', () => {
		const raw = makeLog([
			'not\x00enough\x00fields',
			makeCommit('hash1111111111111111111111111111111111111111', [], 'Alice', 1700000000, 'valid'),
		]);
		const commits = parseGitLogTS(raw);
		equal(commits.length, 1);
		equal(commits[0].message, 'valid');
	});

	it('should handle merge commits with multiple parents', () => {
		const raw = makeCommit(
			'mergehash000000000000000000000000000000000',
			['parent1hash000000000000000000000000000000', 'parent2hash000000000000000000000000000000'],
			'Alice', 1700000000, 'Merge branch'
		);
		const commits = parseGitLogTS(raw);
		equal(commits.length, 1);
		equal(commits[0].parents.length, 2);
	});

	it('should handle invalid timestamps gracefully', () => {
		const raw = makeRecord([
			'hash1111111111111111111111111111111111111111',
			'hash111',
			'',
			'Author',
			'a@b.com',
			'not_a_number',
			'Author',
			'a@b.com',
			'also_bad',
			'msg'
		]);
		const commits = parseGitLogTS(raw);
		equal(commits[0].authorDate, 0);
		equal(commits[0].committerDate, 0);
	});

	it('should handle Unicode content', () => {
		const raw = makeCommit('hash1111111111111111111111111111111111111111', [], '太郎', 1700000000, 'こんにちは世界 🌍');
		const commits = parseGitLogTS(raw);
		equal(commits[0].author, '太郎');
		equal(commits[0].message, 'こんにちは世界 🌍');
	});
});

// ---- Graph lane computation tests (TS fallback) ----

describe('computeGraphLanesTS', () => {
	it('should handle linear history', () => {
		const commits = [
			{ hash: 'c3', parents: ['c2'] },
			{ hash: 'c2', parents: ['c1'] },
			{ hash: 'c1', parents: [] },
		];
		const result = computeGraphLanesTS(commits);
		deepEqual(result.lanes[0], [0]);
		deepEqual(result.lanes[1], [0]);
		deepEqual(result.lanes[2], [0]);
		equal(result.maxLanes, 1);
	});

	it('should handle empty input', () => {
		const result = computeGraphLanesTS([]);
		deepEqual(result.lanes, []);
		equal(result.maxLanes, 0);
	});

	it('should assign merge commits multiple lanes', () => {
		const commits = [
			{ hash: 'merge', parents: ['a', 'b'] },
			{ hash: 'a', parents: ['root'] },
			{ hash: 'b', parents: ['root'] },
			{ hash: 'root', parents: [] },
		];
		const result = computeGraphLanesTS(commits);
		equal(result.lanes[0].length, 2); // merge has two lane entries
		ok(result.maxLanes >= 2);
	});

	it('should handle parallel branches', () => {
		const commits = [
			{ hash: 'a2', parents: ['a1'] },
			{ hash: 'b2', parents: ['b1'] },
			{ hash: 'a1', parents: [] },
			{ hash: 'b1', parents: [] },
		];
		const result = computeGraphLanesTS(commits);
		equal(result.lanes[0][0], 0); // a2 in lane 0
		equal(result.lanes[1][0], 1); // b2 in lane 1
		equal(result.lanes[2][0], 0); // a1 in lane 0
		equal(result.lanes[3][0], 1); // b1 in lane 1
	});

	it('should reuse lanes after root commits', () => {
		const commits = [
			{ hash: 'a', parents: [] },
			{ hash: 'b', parents: [] },
		];
		const result = computeGraphLanesTS(commits);
		equal(result.lanes[0][0], 0);
		equal(result.lanes[1][0], 0); // should reuse freed lane
	});

	it('should handle octopus merge', () => {
		const commits = [
			{ hash: 'merge', parents: ['p1', 'p2', 'p3'] },
			{ hash: 'p1', parents: [] },
			{ hash: 'p2', parents: [] },
			{ hash: 'p3', parents: [] },
		];
		const result = computeGraphLanesTS(commits);
		equal(result.lanes[0].length, 3); // merge has 3 lane entries
	});
});

// ---- Native module tests (if available) ----

if (nativeModule) {
	describe('Native parseGitLog', () => {
		it('should parse a single commit', () => {
			const raw = makeCommit('abc123def456abc123def456abc123def456abc123', [], 'Alice', 1700000000, 'Initial commit');
			const commits = nativeModule.parseGitLog(raw);
			equal(commits.length, 1);
			equal(commits[0].hash, 'abc123def456abc123def456abc123def456abc123');
			equal(commits[0].abbreviatedHash, 'abc123d');
			deepEqual(commits[0].parents, []);
			equal(commits[0].author, 'Alice');
			equal(commits[0].authorDate, 1700000000);
			equal(commits[0].message, 'Initial commit');
		});

		it('should parse multiple commits', () => {
			const raw = makeLog([
				makeCommit('hash2222222222222222222222222222222222222222', ['hash1111111111111111111111111111111111111111'], 'Bob', 1700000100, 'second'),
				makeCommit('hash1111111111111111111111111111111111111111', [], 'Alice', 1700000000, 'first'),
			]);
			const commits = nativeModule.parseGitLog(raw);
			equal(commits.length, 2);
			equal(commits[0].message, 'second');
			equal(commits[1].message, 'first');
		});

		it('should handle empty input', () => {
			const commits = nativeModule.parseGitLog('');
			equal(commits.length, 0);
		});

		it('should handle Unicode content', () => {
			const raw = makeCommit('hash1111111111111111111111111111111111111111', [], '太郎', 1700000000, 'こんにちは世界 🌍');
			const commits = nativeModule.parseGitLog(raw);
			equal(commits[0].author, '太郎');
			equal(commits[0].message, 'こんにちは世界 🌍');
		});

		it('should handle Buffer input', () => {
			const raw = makeCommit('hash1111111111111111111111111111111111111111', [], 'Alice', 1700000000, 'test');
			const commits = nativeModule.parseGitLogBuffer(Buffer.from(raw));
			equal(commits.length, 1);
			equal(commits[0].author, 'Alice');
		});
	});

	describe('Native computeGraphLanes', () => {
		it('should handle linear history', () => {
			const commits = [
				{ hash: 'c3', parents: ['c2'] },
				{ hash: 'c2', parents: ['c1'] },
				{ hash: 'c1', parents: [] },
			];
			const result = nativeModule.computeGraphLanes(commits);
			deepEqual(result.lanes[0], [0]);
			deepEqual(result.lanes[1], [0]);
			deepEqual(result.lanes[2], [0]);
			equal(result.maxLanes, 1);
		});

		it('should handle merge commits', () => {
			const commits = [
				{ hash: 'merge', parents: ['a', 'b'] },
				{ hash: 'a', parents: ['root'] },
				{ hash: 'b', parents: ['root'] },
				{ hash: 'root', parents: [] },
			];
			const result = nativeModule.computeGraphLanes(commits);
			equal(result.lanes[0].length, 2);
			ok(result.maxLanes >= 2);
		});

		it('should handle empty input', () => {
			const result = nativeModule.computeGraphLanes([]);
			deepEqual(result.lanes, []);
			equal(result.maxLanes, 0);
		});
	});

	describe('Native parseBranches', () => {
		it('should parse branch output', () => {
			const s = '\x00';
			const raw = 'main' + s + 'abc1234' + s + '*' + s + 'origin/main' + s + 'refs/heads/main\n' +
				'feature' + s + 'def5678' + s + ' ' + s + '' + s + 'refs/heads/feature\n' +
				'origin/main' + s + 'abc1234' + s + ' ' + s + '' + s + 'refs/remotes/origin/main\n';
			const branches = nativeModule.parseBranches(raw);
			equal(branches.length, 3);
			equal(branches[0].name, 'main');
			equal(branches[0].current, true);
			equal(branches[0].upstream, 'origin/main');
			equal(branches[2].remote, 'origin');
		});

		it('should skip remote HEAD', () => {
			const s = '\x00';
			const raw = 'origin/HEAD' + s + 'abc1234' + s + ' ' + s + '' + s + 'refs/remotes/origin/HEAD\n';
			const branches = nativeModule.parseBranches(raw);
			equal(branches.length, 0);
		});
	});

	describe('Native parseStashes', () => {
		it('should parse stash output', () => {
			const sep = '\x00';
			const raw = 'hash123' + sep + 'stash@{0}' + sep + 'WIP on main' + sep + '1700000000\nhash456' + sep + 'stash@{1}' + sep + 'autosave' + sep + '1700000100\n';
			const stashes = nativeModule.parseStashes(raw);
			equal(stashes.length, 2);
			equal(stashes[0].hash, 'hash123');
			equal(stashes[0].selector, 'stash@{0}');
			equal(stashes[0].date, 1700000000);
		});
	});

	// ---- Parity tests: Native vs TypeScript ----

	describe('Parity: Native vs TypeScript', () => {
		it('parseGitLog should produce identical results', () => {
			const raw = makeLog([
				makeCommit('hash3333333333333333333333333333333333333333', ['hash2222222222222222222222222222222222222222', 'hash1111111111111111111111111111111111111111'], 'Charlie', 1700000200, 'merge'),
				makeCommit('hash2222222222222222222222222222222222222222', ['hash0000000000000000000000000000000000000000'], 'Bob', 1700000100, 'feature'),
				makeCommit('hash1111111111111111111111111111111111111111', ['hash0000000000000000000000000000000000000000'], 'Alice', 1700000050, 'bugfix'),
				makeCommit('hash0000000000000000000000000000000000000000', [], 'Dave', 1700000000, 'initial'),
			]);

			const tsResult = parseGitLogTS(raw);
			const nativeResult = nativeModule.parseGitLog(raw);

			equal(tsResult.length, nativeResult.length, 'commit count mismatch');
			for (let i = 0; i < tsResult.length; i++) {
				equal(nativeResult[i].hash, tsResult[i].hash, `hash mismatch at ${i}`);
				equal(nativeResult[i].abbreviatedHash, tsResult[i].abbreviatedHash, `abbrev hash mismatch at ${i}`);
				deepEqual(nativeResult[i].parents, tsResult[i].parents, `parents mismatch at ${i}`);
				equal(nativeResult[i].author, tsResult[i].author, `author mismatch at ${i}`);
				equal(nativeResult[i].authorEmail, tsResult[i].authorEmail, `email mismatch at ${i}`);
				equal(nativeResult[i].authorDate, tsResult[i].authorDate, `date mismatch at ${i}`);
				equal(nativeResult[i].message, tsResult[i].message, `message mismatch at ${i}`);
			}
		});

		it('computeGraphLanes should produce identical results for linear history', () => {
			const commits = [];
			for (let i = 0; i < 100; i++) {
				commits.push({
					hash: `c${i}`,
					parents: i < 99 ? [`c${i + 1}`] : [],
				});
			}

			const tsResult = computeGraphLanesTS(commits);
			const nativeResult = nativeModule.computeGraphLanes(commits);

			equal(tsResult.maxLanes, nativeResult.maxLanes, 'maxLanes mismatch');
			deepEqual(tsResult.lanes, nativeResult.lanes, 'lanes mismatch');
		});

		it('computeGraphLanes should produce identical results for branchy history', () => {
			const commits = [
				{ hash: 'merge1', parents: ['a3', 'b2'] },
				{ hash: 'a3', parents: ['a2'] },
				{ hash: 'b2', parents: ['b1'] },
				{ hash: 'a2', parents: ['a1'] },
				{ hash: 'b1', parents: ['root'] },
				{ hash: 'a1', parents: ['root'] },
				{ hash: 'root', parents: [] },
			];

			const tsResult = computeGraphLanesTS(commits);
			const nativeResult = nativeModule.computeGraphLanes(commits);

			equal(tsResult.maxLanes, nativeResult.maxLanes, 'maxLanes mismatch');
			deepEqual(tsResult.lanes, nativeResult.lanes, 'lanes mismatch');
		});

		it('parseAndComputeLanes combined parity', () => {
			if (!nativeModule.parseAndComputeLanes) {
				ok(true, 'skipped - combined function not available');
				return;
			}
			const raw = makeLog([
				makeCommit('hash3333333333333333333333333333333333333333', ['hash2222222222222222222222222222222222222222', 'hash1111111111111111111111111111111111111111'], 'Charlie', 1700000200, 'merge'),
				makeCommit('hash2222222222222222222222222222222222222222', ['hash0000000000000000000000000000000000000000'], 'Bob', 1700000100, 'feature'),
				makeCommit('hash1111111111111111111111111111111111111111', ['hash0000000000000000000000000000000000000000'], 'Alice', 1700000050, 'bugfix'),
				makeCommit('hash0000000000000000000000000000000000000000', [], 'Dave', 1700000000, 'initial'),
			]);

			const tsCommits = parseGitLogTS(raw);
			const tsLanes = computeGraphLanesTS(tsCommits);

			const nativeResult = nativeModule.parseAndComputeLanes(raw);
			const nativeCommits = JSON.parse(nativeResult.commitsJson);

			equal(nativeCommits.length, tsCommits.length, 'commit count mismatch');
			for (let i = 0; i < tsCommits.length; i++) {
				equal(nativeCommits[i].hash, tsCommits[i].hash, `hash mismatch at ${i}`);
			}
			equal(nativeResult.maxLanes, tsLanes.maxLanes, 'maxLanes mismatch');
			deepEqual(nativeResult.lanes, tsLanes.lanes, 'lanes mismatch');
		});

		it('computeGraphLanes parity for complex merge patterns', () => {
			const commits = [
				{ hash: 'octopus', parents: ['p1', 'p2', 'p3'] },
				{ hash: 'p1', parents: ['base1'] },
				{ hash: 'p2', parents: ['base1'] },
				{ hash: 'p3', parents: ['base2'] },
				{ hash: 'base1', parents: ['root'] },
				{ hash: 'base2', parents: ['root'] },
				{ hash: 'root', parents: [] },
			];

			const tsResult = computeGraphLanesTS(commits);
			const nativeResult = nativeModule.computeGraphLanes(commits);

			equal(tsResult.maxLanes, nativeResult.maxLanes, 'maxLanes mismatch');
			deepEqual(tsResult.lanes, nativeResult.lanes, 'lanes mismatch');
		});
	});

	// ---- Performance benchmark ----

	describe('Performance Benchmark', () => {
		it('parseGitLog: native vs TS (10000 commits)', () => {
			const records = [];
			for (let i = 0; i < 10000; i++) {
				records.push(makeCommit(
					`h${String(i).padStart(38, '0')}`,
					i > 0 ? [`h${String(i - 1).padStart(38, '0')}`] : [],
					'Author',
					1700000000 + i,
					`commit message number ${i}`
				));
			}
			const raw = makeLog(records);

			// Warm up
			parseGitLogTS(raw);
			nativeModule.parseGitLog(raw);

			// Benchmark TS
			const tsStart = performance.now();
			for (let r = 0; r < 5; r++) parseGitLogTS(raw);
			const tsTime = (performance.now() - tsStart) / 5;

			// Benchmark Native (object path)
			const nStart = performance.now();
			for (let r = 0; r < 5; r++) nativeModule.parseGitLog(raw);
			const nTime = (performance.now() - nStart) / 5;

			// Benchmark Native JSON path
			let nJsonTime = nTime;
			if (nativeModule.parseGitLogJson) {
				const njStart = performance.now();
				for (let r = 0; r < 5; r++) JSON.parse(nativeModule.parseGitLogJson(raw));
				nJsonTime = (performance.now() - njStart) / 5;
			}

			const speedupObj = tsTime / nTime;
			const speedupJson = tsTime / nJsonTime;
			console.log(`      TS: ${tsTime.toFixed(1)}ms, Native(obj): ${nTime.toFixed(1)}ms (${speedupObj.toFixed(1)}x), Native(json): ${nJsonTime.toFixed(1)}ms (${speedupJson.toFixed(1)}x)`);
			ok(true, 'benchmark completed');
		});

		it('parseAndComputeLanes: combined native (10000 commits)', () => {
			const records = [];
			for (let i = 0; i < 10000; i++) {
				records.push(makeCommit(
					`h${String(i).padStart(38, '0')}`,
					i > 0 ? [`h${String(i - 1).padStart(38, '0')}`] : [],
					'Author',
					1700000000 + i,
					`commit message number ${i}`
				));
			}
			const raw = makeLog(records);

			// TS: parse + compute separately
			const tsStart = performance.now();
			for (let r = 0; r < 5; r++) {
				const commits = parseGitLogTS(raw);
				computeGraphLanesTS(commits);
			}
			const tsTime = (performance.now() - tsStart) / 5;

			// Native combined
			if (nativeModule.parseAndComputeLanes) {
				// Warm up
				nativeModule.parseAndComputeLanes(raw);

				const nStart = performance.now();
				for (let r = 0; r < 5; r++) {
					const result = nativeModule.parseAndComputeLanes(raw);
					JSON.parse(result.commitsJson);
				}
				const nTime = (performance.now() - nStart) / 5;
				const speedup = tsTime / nTime;
				console.log(`      TS(parse+compute): ${tsTime.toFixed(1)}ms, Native(combined): ${nTime.toFixed(1)}ms, Speedup: ${speedup.toFixed(1)}x`);
			} else {
				console.log(`      Combined function not available`);
			}
			ok(true, 'benchmark completed');
		});

		it('computeGraphLanes: native vs TS (10000 commits)', () => {
			const commits = [];
			for (let i = 0; i < 10000; i++) {
				commits.push({
					hash: `c${i}`,
					parents: i < 9999 ? [`c${i + 1}`] : [],
				});
			}

			// Warm up
			computeGraphLanesTS(commits);
			nativeModule.computeGraphLanes(commits);

			// Benchmark TS
			const tsStart = performance.now();
			for (let r = 0; r < 5; r++) computeGraphLanesTS(commits);
			const tsTime = (performance.now() - tsStart) / 5;

			// Benchmark Native
			const nStart = performance.now();
			for (let r = 0; r < 5; r++) nativeModule.computeGraphLanes(commits);
			const nTime = (performance.now() - nStart) / 5;

			const speedup = tsTime / nTime;
			console.log(`      TS: ${tsTime.toFixed(1)}ms, Native: ${nTime.toFixed(1)}ms, Speedup: ${speedup.toFixed(1)}x`);
			ok(true, 'benchmark completed');
		});

		it('computeGraphLanes: native vs TS (branchy 5000 commits)', () => {
			// Create a more realistic branchy history
			const commits = [];
			let branchCounter = 0;
			for (let i = 0; i < 5000; i++) {
				if (i % 20 === 0 && i > 0) {
					// Merge commit every 20
					commits.push({
						hash: `merge${branchCounter}`,
						parents: [`c${i - 1}`, `branch${branchCounter}`],
					});
					branchCounter++;
				} else if (i % 10 === 5) {
					// Branch point
					commits.push({
						hash: `branch${branchCounter}`,
						parents: i > 5 ? [`c${i - 5}`] : [],
					});
				} else {
					commits.push({
						hash: `c${i}`,
						parents: i > 0 ? [`c${i - 1}`] : [],
					});
				}
			}

			// Warm up
			computeGraphLanesTS(commits);
			nativeModule.computeGraphLanes(commits);

			const tsStart = performance.now();
			for (let r = 0; r < 5; r++) computeGraphLanesTS(commits);
			const tsTime = (performance.now() - tsStart) / 5;

			const nStart = performance.now();
			for (let r = 0; r < 5; r++) nativeModule.computeGraphLanes(commits);
			const nTime = (performance.now() - nStart) / 5;

			const speedup = tsTime / nTime;
			console.log(`      TS: ${tsTime.toFixed(1)}ms, Native: ${nTime.toFixed(1)}ms, Speedup: ${speedup.toFixed(1)}x`);
			ok(true, 'benchmark completed');
		});
	});
} else {
	console.log('\n  ⚠ Skipping native module tests (module not available)');
}

// ---- Summary ----

console.log('\n  ────────────────────────────────────');
console.log(`  ${passedTests} passing, ${failedTests} failing (${totalTests} total)`);

if (failedTests > 0) {
	console.log('\n  Failed tests:');
	for (const f of failures) {
		console.log(`    - ${f.name}: ${f.error.message}`);
	}
	process.exit(1);
} else {
	console.log('');
	process.exit(0);
}

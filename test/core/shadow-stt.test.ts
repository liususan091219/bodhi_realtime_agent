// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { compareTranscripts, normalizeTranscript } from '../../src/core/shadow-stt.js';

describe('normalizeTranscript', () => {
	it('lowercases, strips punctuation, collapses whitespace', () => {
		expect(normalizeTranscript('  Hi,   Lucy!  ')).toBe('hi lucy');
		expect(normalizeTranscript("Hello, what's this?")).toBe('hello whats this');
	});
	it('keeps CJK', () => {
		expect(normalizeTranscript('你好,Lucy!')).toBe('你好lucy');
	});
});

describe('compareTranscripts', () => {
	it('the live incident: "what\'s the news" vs "what\'s this" DIVERGES', () => {
		// Rui 2026-07-30 09:39 — Gemini Live heard news, batch STT heard this.
		const r = compareTranscripts("Hello, what's the news?", "Hello, what's this?");
		expect(r.diverged).toBe(true);
		expect(r.reason).toBe('diverged');
	});

	it('wake-name substitution diverges (Lucy → Siri)', () => {
		expect(
			compareTranscripts(
				'Hello, Siri. Switch to meeting mode.',
				'Oh hi Lucy, switch to meeting mode.',
			).diverged,
		).toBe(true);
	});

	it('identical after normalization is a match', () => {
		expect(compareTranscripts("HI, what's this?", 'hi whats this').diverged).toBe(false);
	});

	it('containment = streaming truncation, NOT a mishear', () => {
		// 22% of raw log divergences were containment artifacts (07-30 mining).
		const r = compareTranscripts('what should i', 'Um yeah, what should I look at first?');
		expect(r.diverged).toBe(false);
		expect(r.reason).toBe('match');
	});

	it('empty sides never diverge (coverage gap ≠ mishear)', () => {
		expect(compareTranscripts('', 'hi lucy').reason).toBe('empty-live');
		expect(compareTranscripts('hi lucy', '').reason).toBe('empty-shadow');
		expect(compareTranscripts('', '').reason).toBe('both-empty');
		for (const pair of [
			['', 'x'],
			['x', ''],
			['', ''],
		] as const) {
			expect(compareTranscripts(pair[0], pair[1]).diverged).toBe(false);
		}
	});

	it('punctuation-only differences are a match (comma vs period harness trap, 07-30)', () => {
		expect(compareTranscripts('Hello. What’s this?', 'Hello, what’s this?').diverged).toBe(false);
	});
});

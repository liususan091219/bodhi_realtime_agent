// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';

vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;
	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
					return {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
				}),
			},
		})),
		_getMessageHandler: () => messageHandler,
	};
});

vi.mock('ai', () => ({
	generateText: vi.fn(async (opts: { onStepFinish?: (step: unknown) => void }) => {
		opts.onStepFinish?.({ toolCalls: [], usage: { totalTokens: 10 } });
		return { text: 'done' };
	}),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;
const echoAgent = (): MainAgent => ({ name: 'echo', instructions: 'echo', tools: [] });

describe('turn lifecycle ids', () => {
	let session: VoiceSession | null = null;
	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	it('start, interrupted and end of ONE turn all carry the SAME id', async () => {
		// turn.start adds one and handleTurnComplete increments before publishing,
		// so both name the turn 1-based. handleInterrupted published the LIVE
		// counter, which is one behind — an interrupt and the end of the very same
		// turn reported different ids, and a consumer keying a per-turn record on
		// them could never join the two.
		//
		// The 1-based pairing is the contract turn.start established; this aligns
		// the third event to it rather than re-numbering the other two.
		session = new VoiceSession({
			sessionId: 'sess_ids',
			userId: 'u',
			apiKey: 'k',
			agents: [echoAgent()],
			initialAgent: 'echo',
			port: 9887,
			model: mockModel,
		});
		const starts: string[] = [];
		const interrupted: string[] = [];
		const ends: string[] = [];
		session.eventBus.subscribe('turn.start', (p) => starts.push(p.turnId));
		session.eventBus.subscribe('turn.interrupted', (p) => interrupted.push(p.turnId));
		session.eventBus.subscribe('turn.end', (p) => ends.push(p.turnId));

		await session.start();
		await new Promise((r) => setTimeout(r, 50));
		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (m: unknown) => void)();

		fire({
			serverContent: {
				modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm' } }] },
			},
		});
		await new Promise((r) => setTimeout(r, 20));
		fire({ serverContent: { interrupted: true } });
		await new Promise((r) => setTimeout(r, 20));
		fire({ serverContent: { turnComplete: true } });
		await new Promise((r) => setTimeout(r, 50));

		expect(starts).toEqual(['turn_1']);
		expect(ends).toEqual(['turn_1']);
		expect(interrupted).toEqual(['turn_1']); // was 'turn_0'
	});

	it('generationComplete reaches the transport callback', async () => {
		// Gemini sends it separately from turnComplete and only the latter was
		// read, so the finer boundary was invisible upstream. Surfaced only —
		// nothing in this change consumes it.
		session = new VoiceSession({
			sessionId: 'sess_gen',
			userId: 'u',
			apiKey: 'k',
			agents: [echoAgent()],
			initialAgent: 'echo',
			port: 9888,
			model: mockModel,
		});
		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		let fired = 0;
		// WRAP, do not replace. Replacing the transport's own handler disables
		// whatever VoiceSession registered there, and a guard that silently stops
		// covering the site it guards is the kind nobody re-audits.
		// biome-ignore lint/suspicious/noExplicitAny: reaching the transport for a callback assertion
		const t = (session as any).transport as { onGenerationComplete?: () => void };
		const prev = t.onGenerationComplete;
		t.onGenerationComplete = () => {
			fired++;
			prev?.();
		};

		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (m: unknown) => void)();
		fire({ serverContent: { generationComplete: true } });
		await new Promise((r) => setTimeout(r, 30));

		expect(fired).toBe(1);
	});
});

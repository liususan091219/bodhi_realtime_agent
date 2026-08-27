// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { STTProvider } from '../../src/types/transport.js';

// Mock the external deps
vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;
	let mockSession: Record<string, ReturnType<typeof vi.fn>> | null = null;

	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					// Fire setupComplete so connect() resolves (it awaits this)
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
					mockSession = {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
					return mockSession;
				}),
			},
		})),
		_getMessageHandler: () => messageHandler,
		_getMockSession: () => mockSession,
	};
});

vi.mock('ai', () => ({
	generateText: vi.fn(async (opts: { onStepFinish?: (step: unknown) => void }) => {
		opts.onStepFinish?.({ toolCalls: [], usage: { totalTokens: 10 } });
		return { text: 'subagent done' };
	}),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createEchoAgent(): MainAgent {
	return {
		name: 'echo',
		instructions: 'You are an echo agent',
		tools: [],
	};
}

function createGreetingAgent(): MainAgent {
	return {
		name: 'greeter',
		instructions: 'You are a greeting agent',
		greeting: '[System: Greet the user warmly.]',
		tools: [],
	};
}

function createToolAgent(): MainAgent {
	return {
		name: 'tool-agent',
		instructions: 'You have tools',
		tools: [
			{
				name: 'get_weather',
				description: 'Get weather',
				parameters: z.object({ city: z.string() }),
				execution: 'inline',
				execute: async () => ({ temp: 72, unit: 'F' }),
			},
		],
	};
}

function createFailingToolAgent(): MainAgent {
	return {
		name: 'failing-tool-agent',
		instructions: 'Agent with a tool that throws',
		tools: [
			{
				name: 'broken_tool',
				description: 'A tool that always throws',
				parameters: z.object({ input: z.string() }),
				execution: 'inline',
				execute: async () => {
					throw new Error('Tool execution failed');
				},
			},
		],
	};
}

function createBackgroundToolAgent(): MainAgent {
	return {
		name: 'bg-tool-agent',
		instructions: 'Agent with background tool',
		tools: [
			{
				name: 'slow_task',
				description: 'A slow background task',
				parameters: z.object({ task: z.string() }),
				execution: 'background',
				pendingMessage: 'Working on it...',
				execute: async () => ({ done: true }),
			},
		],
	};
}

describe('turn lifecycle identity (real session)', () => {
	let session: VoiceSession | null = null;

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	it('turn.end names the turn that ENDED, and turn.start actually fires', async () => {
		// Driven through the real VoiceSession and the mocked provider, not a
		// re-implementation of the publishing shape. Before this change:
		//   * turn.end read `turn_${this.turnId}` AFTER the increment, so it named
		//     the turn about to start — audio filed under one id and the matching
		//     turn.interrupted under another could never be joined;
		//   * turn.start was declared in the event map and published by NOTHING.
		session = new VoiceSession({
			sessionId: 'sess_ids',
			userId: 'u',
			apiKey: 'k',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9887,
			model: mockModel,
		});
		const starts: string[] = [];
		const ends: string[] = [];
		session.eventBus.subscribe('turn.start', (p) => starts.push(p.turnId));
		session.eventBus.subscribe('turn.end', (p) => ends.push(p.turnId));

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

		// One generation: audio, then the provider closes the turn.
		fire({
			serverContent: {
				modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm' } }] },
			},
		});
		await new Promise((r) => setTimeout(r, 20));
		fire({ serverContent: { turnComplete: true } });
		await new Promise((r) => setTimeout(r, 50));

		expect(starts.length).toBeGreaterThan(0);
		expect(ends.length).toBe(1);
		expect(ends[0]).toBe(starts[0]);
	});

	it('generationComplete reaches the transport callback', async () => {
		// Gemini sends it separately from turnComplete and bodhi read only the
		// latter, so the finer boundary was invisible upstream.
		session = new VoiceSession({
			sessionId: 'sess_gen',
			userId: 'u',
			apiKey: 'k',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9888,
			model: mockModel,
		});
		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		let fired = 0;
		// biome-ignore lint/suspicious/noExplicitAny: reaching the transport for a callback assertion
		((session as any).transport as { onGenerationComplete?: () => void }).onGenerationComplete =
			() => {
				fired++;
			};

		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
		fire({ serverContent: { generationComplete: true } });
		await new Promise((r) => setTimeout(r, 30));

		expect(fired).toBe(1);
	});
});

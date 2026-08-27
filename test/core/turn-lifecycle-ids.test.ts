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

	it('turn.end names the turn that ENDED — the same id an interrupt for it carries', async () => {
		// Driven through the real VoiceSession and the mocked provider, not a
		// re-implementation of the publishing shape: an earlier draft asserted
		// the shape and passed against the bug.
		//
		// turn.end read `turn_${this.turnId}` AFTER the increment, so it named
		// the turn about to START. handleInterrupted publishes the LIVE turnId
		// and does not increment, so an interrupt and the end of the very same
		// turn carried different ids and could never be joined — which is how
		// this surfaced downstream.
		session = new VoiceSession({
			sessionId: 'sess_ids',
			userId: 'u',
			apiKey: 'k',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9887,
			model: mockModel,
		});
		const interrupted: string[] = [];
		const ends: string[] = [];
		session.eventBus.subscribe('turn.interrupted', (p) => interrupted.push(p.turnId));
		session.eventBus.subscribe('turn.end', (p) => ends.push(p.turnId));

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

		// One generation: audio, barged in on, then the provider closes the turn.
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

		expect(interrupted).toEqual(['turn_0']);
		expect(ends).toEqual(['turn_0']); // was 'turn_1'
	});

	// ---- generation boundary (the state machine) ----------------------------
	//
	// These assert a TRACE, not a count. Counting is not enough: before this
	// change `audio → turnComplete → toolCall → audio` also produced two
	// starts, but as one bogus start (the tool tail) plus one real one. Same
	// number, different composition. The trace names the event each start
	// fired on, so a test cannot pass for the wrong reason.

	const AUDIO = {
		serverContent: {
			modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm' } }] },
		},
	};
	const TOOL_CALL = {
		toolCall: { functionCalls: [{ id: 'fc_1', name: 'get_weather', args: { city: 'Boston' } }] },
	};
	const TURN_COMPLETE = { serverContent: { turnComplete: true } };
	const GEN_COMPLETE = { serverContent: { generationComplete: true } };
	const INTERRUPTED = { serverContent: { interrupted: true } };

	/**
	 * Drive a real session through a labelled provider script and return the
	 * labels of the events that opened a generation.
	 */
	async function startsFiredOn(
		port: number,
		sessionId: string,
		script: [string, unknown][],
	): Promise<{ trace: string[]; published: string[] }> {
		session = new VoiceSession({
			sessionId,
			userId: 'u',
			apiKey: 'k',
			agents: [createToolAgent()],
			initialAgent: 'tool-agent',
			port,
			model: mockModel,
		});
		const published: string[] = [];
		session.eventBus.subscribe('turn.start', (p) => published.push(p.turnId));
		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		let fired = 0;
		// biome-ignore lint/suspicious/noExplicitAny: reaching the transport for a callback assertion
		const t = (session as any).transport as { onModelTurnStart?: () => void };
		const inner = t.onModelTurnStart;
		t.onModelTurnStart = () => {
			fired++;
			inner?.();
		};

		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (m: unknown) => void)();
		const trace: string[] = [];
		for (const [label, msg] of script) {
			const before = fired;
			fire(msg);
			await new Promise((r) => setTimeout(r, 25));
			if (fired > before) trace.push(label);
		}
		await new Promise((r) => setTimeout(r, 40));
		return { trace, published };
	}

	it('a toolCall after turnComplete stays in the SAME generation', async () => {
		// The defect this change exists for: turnComplete cleared the "a turn is
		// underway" boolean, so the tool call that finishes an answer was
		// relabelled the start of a new model turn — one answer, two candidates
		// downstream. Before: ['audio', 'toolCall'].
		const { trace, published } = await startsFiredOn(9889, 'sess_tool_tail', [
			['audio', AUDIO],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
		]);
		expect(trace).toEqual(['audio']);
		expect(published).toEqual(['turn_0']);
	});

	it('the answer built from a tool result IS a new generation', async () => {
		// The other half: identity surviving turnComplete must not swallow the
		// next real answer. The model speaking again cannot be the tail of a
		// completed turn, so audio from `draining` opens a new generation.
		// Before this change the count was also 2 — but as ['audio','toolCall'],
		// crediting the tool tail and missing the answer entirely.
		const { trace } = await startsFiredOn(9890, 'sess_tool_answer', [
			['audio-1', AUDIO],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
			['audio-2', AUDIO],
		]);
		expect(trace).toEqual(['audio-1', 'audio-2']);
	});

	it('generationComplete ends the generation; the next output opens a new one', async () => {
		// Before: ['audio', 'toolCall'] — right count, and right here by luck,
		// since the boolean happened to be clear. The trace pins WHY.
		const { trace } = await startsFiredOn(9891, 'sess_gen_terminal', [
			['audio', AUDIO],
			['generationComplete', GEN_COMPLETE],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
		]);
		expect(trace).toEqual(['audio', 'toolCall']);
	});

	it('an interrupt ends the generation', async () => {
		// Barge-in: nothing after it belongs to the interrupted answer. Before
		// this change handleInterrupted left the boolean set, so the next
		// output produced NO start at all — trace was ['audio'].
		const { trace } = await startsFiredOn(9892, 'sess_interrupt_terminal', [
			['audio', AUDIO],
			['interrupted', INTERRUPTED],
			['toolCall', TOOL_CALL],
		]);
		expect(trace).toEqual(['audio', 'toolCall']);
	});

	it('does not wedge when generationComplete never arrives', async () => {
		// The machine must not depend on generationComplete being reliable: I
		// have NOT verified that Gemini always sends it. Three plain turns with
		// only turnComplete must still be three generations.
		const { trace } = await startsFiredOn(9893, 'sess_no_gencomplete', [
			['audio-1', AUDIO],
			['turnComplete-1', TURN_COMPLETE],
			['audio-2', AUDIO],
			['turnComplete-2', TURN_COMPLETE],
			['audio-3', AUDIO],
			['turnComplete-3', TURN_COMPLETE],
		]);
		expect(trace).toEqual(['audio-1', 'audio-2', 'audio-3']);
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

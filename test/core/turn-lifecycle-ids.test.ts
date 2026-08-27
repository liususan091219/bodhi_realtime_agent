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

	// ---- generation lifecycle (the state machine) ---------------------------
	//
	// These assert a TRACE of the paired generation.start / generation.end
	// events, not a count. Counting is not enough: before the state machine,
	// `audio → turnComplete → toolCall → audio` also produced two starts, but
	// as one bogus start on the tool tail plus one real one, with the actual
	// answer credited to nothing. Same number, different composition.

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
	 * Drive a real session through a labelled provider script and report the
	 * generation lifecycle it produced:
	 *   openedOn — the label of each event that opened a generation
	 *   lifecycle — every generation.start / generation.end, in order
	 *   turnStarts — turn.start payloads, which must stay empty: turn.* observes
	 *                the Gemini protocol and is not the candidate boundary
	 */
	async function lifecycleOf(
		port: number,
		sessionId: string,
		script: [string, unknown][],
	): Promise<{
		openedOn: string[];
		lifecycle: string[];
		turnStarts: string[];
		turnEnds: string[];
	}> {
		session = new VoiceSession({
			sessionId,
			userId: 'u',
			apiKey: 'k',
			agents: [createToolAgent()],
			initialAgent: 'tool-agent',
			port,
			model: mockModel,
		});
		const lifecycle: string[] = [];
		const turnStarts: string[] = [];
		const turnEnds: string[] = [];
		const turnInterrupts: string[] = [];
		let opened = 0;
		session.eventBus.subscribe('generation.start', (p) => {
			opened++;
			lifecycle.push(`start:${p.generationId}`);
		});
		session.eventBus.subscribe('generation.end', (p) =>
			lifecycle.push(`end:${p.generationId}:${p.reason}`),
		);
		session.eventBus.subscribe('turn.start', (p) => turnStarts.push(p.turnId));
		session.eventBus.subscribe('turn.end', (p) => turnEnds.push(p.turnId));
		session.eventBus.subscribe('turn.interrupted', (p) => turnInterrupts.push(p.turnId));

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (m: unknown) => void)();
		const openedOn: string[] = [];
		for (const [label, msg] of script) {
			const before = opened;
			fire(msg);
			await new Promise((r) => setTimeout(r, 25));
			if (opened > before) openedOn.push(label);
		}
		await new Promise((r) => setTimeout(r, 40));
		return { openedOn, lifecycle, turnStarts, turnEnds, turnInterrupts };
	}

	it('a toolCall after turnComplete stays in the SAME generation', async () => {
		// The defect all of this exists for: turnComplete cleared the "a turn is
		// underway" boolean, so the tool call that finishes an answer was
		// relabelled the start of a new model turn — one answer, two candidates
		// downstream. Before: opened on ['audio', 'toolCall'].
		const { openedOn, lifecycle, turnEnds } = await lifecycleOf(9889, 'sess_tool_tail', [
			['audio', AUDIO],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
		]);
		expect(openedOn).toEqual(['audio']);
		// Still open — draining, not ended. turnComplete is not a generation end.
		expect(lifecycle).toEqual(['start:gen_0']);
		// ...while turn.end DID fire, which is exactly why a consumer must not
		// key its candidate on it.
		expect(turnEnds).toEqual(['turn_0']);
	});

	it('turnComplete → tool tail → interrupt keeps ONE generation identity', async () => {
		// The combination the earlier round missed. VoiceSession's turnId has
		// already incremented at turnComplete, so anything keyed on turnId
		// reports this generation's own interrupt under the NEXT turn's id.
		// generationId does not move, so start and end agree.
		const { openedOn, lifecycle, turnEnds, turnInterrupts } = await lifecycleOf(
			9894,
			'sess_tail_interrupt',
			[
				['audio', AUDIO],
				['turnComplete', TURN_COMPLETE],
				['toolCall', TOOL_CALL],
				['interrupted', INTERRUPTED],
			],
		);
		expect(openedOn).toEqual(['audio']);
		expect(lifecycle).toEqual(['start:gen_0', 'end:gen_0:interrupted']);
		// And the drift these events exist to escape, asserted rather than
		// described: for ONE generation the protocol events disagree, because
		// turnId moved at turnComplete while the generation kept draining.
		expect(turnEnds).toEqual(['turn_0']);
		expect(turnInterrupts).toEqual(['turn_1']);
	});

	it('the answer built from a tool result IS a new generation', async () => {
		// The other half: identity surviving turnComplete must not swallow the
		// next real answer. The model speaking again cannot be the tail of a
		// completed turn, so audio from `draining` supersedes and opens a new
		// generation. Before, the count was also 2 — as ['audio','toolCall'],
		// crediting the tool tail and missing the answer entirely.
		const { openedOn, lifecycle } = await lifecycleOf(9890, 'sess_tool_answer', [
			['audio-1', AUDIO],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
			['audio-2', AUDIO],
		]);
		expect(openedOn).toEqual(['audio-1', 'audio-2']);
		expect(lifecycle).toEqual(['start:gen_0', 'end:gen_0:superseded', 'start:gen_1']);
	});

	it('generationComplete ends the generation; the next output opens a new one', async () => {
		const { openedOn, lifecycle } = await lifecycleOf(9891, 'sess_gen_terminal', [
			['audio', AUDIO],
			['generationComplete', GEN_COMPLETE],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
		]);
		expect(openedOn).toEqual(['audio', 'toolCall']);
		expect(lifecycle).toEqual(['start:gen_0', 'end:gen_0:generationComplete', 'start:gen_1']);
	});

	it('an interrupt ends the generation', async () => {
		// Before the state machine, handleInterrupted left the boolean set, so
		// the next output produced NO start at all.
		const { openedOn, lifecycle } = await lifecycleOf(9892, 'sess_interrupt_terminal', [
			['audio', AUDIO],
			['interrupted', INTERRUPTED],
			['toolCall', TOOL_CALL],
		]);
		expect(openedOn).toEqual(['audio', 'toolCall']);
		expect(lifecycle).toEqual(['start:gen_0', 'end:gen_0:interrupted', 'start:gen_1']);
	});

	it('does not wedge when generationComplete never arrives', async () => {
		// The machine must not depend on generationComplete being reliable: I
		// have NOT verified that Gemini always sends it. Three plain turns with
		// only turnComplete must still be three generations, each properly
		// closed.
		const { openedOn, lifecycle } = await lifecycleOf(9893, 'sess_no_gencomplete', [
			['audio-1', AUDIO],
			['turnComplete-1', TURN_COMPLETE],
			['audio-2', AUDIO],
			['turnComplete-2', TURN_COMPLETE],
			['audio-3', AUDIO],
			['turnComplete-3', TURN_COMPLETE],
		]);
		expect(openedOn).toEqual(['audio-1', 'audio-2', 'audio-3']);
		expect(lifecycle).toEqual([
			'start:gen_0',
			'end:gen_0:superseded',
			'start:gen_1',
			'end:gen_1:superseded',
			'start:gen_2',
		]);
	});

	it('turn.start is not the candidate boundary and stays unpublished', async () => {
		// turn.* observes the Gemini protocol. Publishing turn.start as a
		// generation start while turn.end remained turnComplete would make the
		// public pair contradict itself.
		const { turnStarts, turnEnds } = await lifecycleOf(9895, 'sess_no_turn_start', [
			['audio', AUDIO],
			['turnComplete', TURN_COMPLETE],
		]);
		expect(turnStarts).toEqual([]);
		expect(turnEnds).toEqual(['turn_0']);
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

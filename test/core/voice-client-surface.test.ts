// SPDX-License-Identifier: MIT
//
// Host-facing client surface (desktop design doc
// design-voice-active-silence-recovery.md, server responsibilities): a hook
// for client protocol commands the built-in chain does not handle (e.g.
// voice.retryUpstream), a public JSON push to the attached client (e.g. the
// durable voice-stalled state), and attach/detach config hooks so the host
// can resend terminal state on attach.

import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
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
					setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'gs' } }), 5);
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
vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'ok' })) }));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;
const echo = (): MainAgent => ({ name: 'echo', instructions: 'echo', tools: [] });

async function startSession(
	port: number,
	extraConfig: Record<string, unknown> = {},
): Promise<VoiceSession> {
	const s = new VoiceSession({
		sessionId: 'sess_cs',
		userId: 'u',
		apiKey: 'k',
		agents: [echo()],
		initialAgent: 'echo',
		port,
		model: mockModel,
		hooks: {},
		...extraConfig,
	});
	await s.start();
	await new Promise((r) => setTimeout(r, 40));
	return s;
}

function openClient(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('host-facing client surface', () => {
	let session: VoiceSession | null = null;
	let client: WebSocket | null = null;
	afterEach(async () => {
		if (client) {
			client.close();
			client = null;
		}
		if (session) await session.close();
		session = null;
	});

	it('routes unhandled client frames to onClientCommand; built-ins stay first', async () => {
		const commands: Array<Record<string, unknown>> = [];
		session = await startSession(9951, {
			onClientCommand: (msg: Record<string, unknown>) => {
				commands.push(msg);
			},
		});
		client = await openClient(9951);
		const retry = {
			type: 'voice.retryUpstream',
			version: 1,
			voiceSessionId: 'vs_1',
			clientEpoch: 0,
			stalledAttemptEpoch: 1,
			requestId: 'req-1',
		};
		client.send(JSON.stringify(retry));
		// A built-in frame must be handled by the built-in chain, not the hook.
		client.send(JSON.stringify({ type: 'text_input', text: 'hello' }));
		await settle();
		expect(commands.length).toBe(1);
		expect(commands[0]).toEqual(retry);
	});

	it('an unhandled frame with no hook registered is ignored without error', async () => {
		session = await startSession(9952);
		client = await openClient(9952);
		client.send(JSON.stringify({ type: 'voice.retryUpstream', version: 1 }));
		await settle();
		// The session survives and the built-ins still work afterwards.
		expect(session.clientConnected).toBe(true);
	});

	it('sendJsonToClient pushes a host-owned frame to the attached client', async () => {
		session = await startSession(9953);
		client = await openClient(9953);
		const frames: string[] = [];
		client.on('message', (data, isBinary) => {
			if (!isBinary) frames.push(data.toString());
		});
		await settle();
		const stalled = {
			type: 'voice-stalled',
			version: 1,
			voiceSessionId: 'vs_1',
			clientEpoch: 0,
			stalledAttemptEpoch: 1,
			episodeAttempts: 3,
			reason: 'active-silence-attempts-exhausted',
			enteredAtUnixMs: 1755550000000,
		};
		session.sendJsonToClient(stalled);
		await settle();
		const parsed = frames.map((f) => JSON.parse(f) as Record<string, unknown>);
		expect(parsed.some((m) => m.type === 'voice-stalled')).toBe(true);
		expect(parsed.find((m) => m.type === 'voice-stalled')).toEqual(stalled);
	});

	it('fires onClientConnected / onClientDisconnected on real attach edges', async () => {
		const edges: string[] = [];
		session = await startSession(9954, {
			onClientConnected: () => {
				edges.push('connected');
			},
			onClientDisconnected: () => {
				edges.push('disconnected');
			},
		});
		client = await openClient(9954);
		await settle();
		expect(edges).toContain('connected');
		client.close();
		client = null;
		await settle(80);
		expect(edges).toContain('disconnected');
	});
});

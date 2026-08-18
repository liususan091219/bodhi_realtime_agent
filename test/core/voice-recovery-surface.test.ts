// SPDX-License-Identifier: MIT
//
// Recovery surface for the engine's ACTIVE-silence watchdog (desktop design
// doc: design-voice-active-silence-recovery.md): atomic recoverUpstream,
// epoch-keyed reconnect boundary, generation-fenced turn.start publication,
// the versioned capability descriptor, and the synthetic-input hold.

import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_CAPABILITIES, VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';

vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;
	let mockSession: Record<string, ReturnType<typeof vi.fn>> | null = null;
	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs' } }), 5);
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
vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'ok' })) }));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;
const echo = (): MainAgent => ({ name: 'echo', instructions: 'echo', tools: [] });

async function startSession(
	port: number,
	hooks: Record<string, unknown> = {},
): Promise<VoiceSession> {
	const s = new VoiceSession({
		sessionId: 'sess_rs',
		userId: 'u',
		apiKey: 'k',
		agents: [echo()],
		initialAgent: 'echo',
		port,
		model: mockModel,
		hooks,
	});
	await s.start();
	await new Promise((r) => setTimeout(r, 40));
	return s;
}
const fire = async (): Promise<(m: unknown) => void> => {
	const { _getMessageHandler } = await import('@google/genai');
	return (_getMessageHandler as unknown as () => (m: unknown) => void)();
};

describe('recovery surface', () => {
	let session: VoiceSession | null = null;
	afterEach(async () => {
		if (session) await session.close();
		session = null;
	});

	it('exports a versioned capability descriptor and exposes it on the session', async () => {
		expect(RECOVERY_CAPABILITIES.version).toBe(1);
		expect(RECOVERY_CAPABILITIES.recoverUpstream).toBe(true);
		expect(RECOVERY_CAPABILITIES.reconnectBoundary).toBe(true);
		expect(RECOVERY_CAPABILITIES.turnStartPublication).toBe(true);
		expect(RECOVERY_CAPABILITIES.syntheticHold).toBe(true);
		session = await startSession(9931);
		expect(session.getRecoveryCapabilities()).toEqual(RECOVERY_CAPABILITIES);
	});

	it('publishes generation-fenced turn.start on the first model part of a turn', async () => {
		session = await startSession(9932);
		const events: unknown[] = [];
		session.eventBus.subscribe('turn.start', (e: unknown) => events.push(e));
		(await fire())({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
		expect(events.length).toBe(1);
		const ev = events[0] as { transportGeneration: number };
		expect(typeof ev.transportGeneration).toBe('number');
		// Same turn: no duplicate publication.
		(await fire())({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'BBBB' } }] } } });
		expect(events.length).toBe(1);
	});

	it('recoverUpstream: atomic sequence, sync attemptEpoch, activated resolves, no greeting/injection', async () => {
		session = await startSession(9933);
		const sent: unknown[] = [];
		const sendSpy = vi
			.spyOn(
				session.transport as unknown as { sendContent: (c: unknown, t: boolean) => void },
				'sendContent',
			)
			.mockImplementation((c: unknown) => {
				sent.push(c);
			});
		const boundaries: unknown[] = [];
		session.eventBus.subscribe('session.reconnectBoundary', (e: unknown) => boundaries.push(e));

		session.sessionManager.updateResumptionHandle('stale_handle');
		expect(session.sessionManager.state).toBe('ACTIVE');

		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		// Synchronous contract: state already CLOSED->CONNECTING, epoch known.
		expect(typeof r.attemptEpoch).toBe('number');
		expect(session.sessionManager.state).toBe('CONNECTING');
		expect(session.sessionManager.resumptionHandle).toBe(null);
		expect(boundaries.length).toBe(1);

		await r.activated;
		expect(session.sessionManager.state).toBe('ACTIVE');
		const text = JSON.stringify(sent);
		expect(text.includes('reconnected')).toBe(false); // no context injection
		expect(text.includes('Greet')).toBe(false); // no greeting
		sendSpy.mockRestore();
	});

	it('recoverUpstream is single-flight while a dial is pending', async () => {
		session = await startSession(9934);
		const a = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		const b = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		expect(b).toBe(a);
		await a.activated;
	});

	it('reconnect boundary is idempotent per epoch (one event, replays are no-ops)', async () => {
		session = await startSession(9935);
		const boundaries: unknown[] = [];
		session.eventBus.subscribe('session.reconnectBoundary', (e: unknown) => boundaries.push(e));
		const priv = session as unknown as { beginReconnectBoundary: (r: string, g: number) => void };
		priv.beginReconnectBoundary('test', 7);
		priv.beginReconnectBoundary('test', 7);
		expect(boundaries.length).toBe(1);
		priv.beginReconnectBoundary('test', 8);
		expect(boundaries.length).toBe(2);
	});

	it('synthetic hold: queued notifications stay held until fresh user speech, then release once', async () => {
		session = await startSession(9936);
		const sendSpy = vi
			.spyOn(
				session.transport as unknown as { sendContent: (c: unknown, t: boolean) => void },
				'sendContent',
			)
			.mockImplementation(() => {});
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		await r.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);

		session.notificationQueue.sendOrQueue(
			[{ role: 'user', parts: [{ text: '[SUBAGENT UPDATE]: held?' }] }],
			true,
		);
		const heldCalls = sendSpy.mock.calls.length;
		// Nothing synthetic may reach the transport while held.
		expect(JSON.stringify(sendSpy.mock.calls).includes('held?')).toBe(false);

		// Fresh user speech (input transcription) releases the hold…
		const priv = session as unknown as { handleUserSpeechEvidence: () => void };
		priv.handleUserSpeechEvidence();
		expect(session.isSyntheticHoldActive()).toBe(false);
		// …and the queue can drain through its normal turn-complete path.
		session.notificationQueue.onTurnComplete();
		expect(JSON.stringify(sendSpy.mock.calls).includes('held?')).toBe(true);
		expect(sendSpy.mock.calls.length).toBeGreaterThan(heldCalls);
		sendSpy.mockRestore();
	});

	it('a late incumbent close after the replacement is ACTIVE is a no-op', async () => {
		session = await startSession(9937);
		const { _getMockSession } = await import('@google/genai');
		const incumbent = (_getMockSession as unknown as () => { close: ReturnType<typeof vi.fn> })();
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		await r.activated;
		expect(session.sessionManager.state).toBe('ACTIVE');
		// Incumbent cleanup ran (close attempted) without touching the new session.
		await r.incumbentClosed;
		expect(incumbent.close).toHaveBeenCalled();
		expect(session.sessionManager.state).toBe('ACTIVE');
	});
});

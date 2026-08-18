// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GeminiLiveTransport } from '../../src/transport/gemini-live-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';

// Mock @google/genai
let capturedConnectConfig: Record<string, unknown> = {};
const mockSession = {
	sendRealtimeInput: vi.fn(),
	sendToolResponse: vi.fn(),
	sendClientContent: vi.fn(),
	close: vi.fn(),
};

vi.mock('@google/genai', () => ({
	GoogleGenAI: vi.fn().mockImplementation(() => ({
		live: {
			connect: vi.fn(async (params: Record<string, unknown>) => {
				capturedConnectConfig = params;
				const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
				cbs.onopen?.();
				// Fire setupComplete so connect() resolves (it awaits this)
				setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'mock_sid' } }), 1);
				return mockSession;
			}),
		},
	})),
}));

function createTestTool(): ToolDefinition {
	return {
		name: 'search',
		description: 'Search the web',
		parameters: z.object({ query: z.string() }),
		execution: 'inline',
		execute: vi.fn(async () => 'result'),
	};
}

describe('GeminiLiveTransport', () => {
	beforeEach(() => {
		mockSession.sendRealtimeInput.mockClear();
		mockSession.sendToolResponse.mockClear();
		mockSession.sendClientContent.mockClear();
		mockSession.close.mockClear();
	});

	describe('connect', () => {
		it('builds correct config with defaults', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			expect(capturedConnectConfig.model).toBe('gemini-live-2.5-flash-preview');
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.responseModalities).toEqual(['AUDIO']);
			expect(config.sessionResumption).toEqual({});
			expect(config.inputAudioTranscription).toEqual({});
		});

		it('includes system instruction when provided', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', systemInstruction: 'Be helpful' },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.systemInstruction).toBe('Be helpful');
		});

		it('includes tools as function declarations', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', tools: [createTestTool()] },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			const tools = config.tools as Array<{
				functionDeclarations: Array<Record<string, unknown>>;
			}>;
			expect(tools[0].functionDeclarations[0].name).toBe('search');
			expect(tools[0].functionDeclarations[0].description).toBe('Search the web');
		});

		it('includes googleSearch when enabled', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', googleSearch: true, tools: [createTestTool()] },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			const tools = config.tools as Array<Record<string, unknown>>;
			expect(tools).toHaveLength(2);
			expect(tools[0]).toEqual({ googleSearch: {} });
			expect(tools[1]).toHaveProperty('functionDeclarations');
		});

		it('omits googleSearch when not set', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', tools: [createTestTool()] },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			const tools = config.tools as Array<Record<string, unknown>>;
			expect(tools).toHaveLength(1);
			expect(tools[0]).toHaveProperty('functionDeclarations');
		});

		it('supports googleSearch without function declarations', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key', googleSearch: true }, {});
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			const tools = config.tools as Array<Record<string, unknown>>;
			expect(tools).toHaveLength(1);
			expect(tools[0]).toEqual({ googleSearch: {} });
		});

		it('includes inputAudioTranscription by default', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.inputAudioTranscription).toEqual({});
		});

		it('omits inputAudioTranscription when explicitly disabled', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', inputAudioTranscription: false },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.inputAudioTranscription).toBeUndefined();
		});

		it('includes resumption handle', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', resumptionHandle: 'handle_abc' },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'handle_abc' });
		});

		it('sets isConnected after connect', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			expect(transport.isConnected).toBe(false);
			await transport.connect();
			expect(transport.isConnected).toBe(true);
		});

		it('rejects with timeout when setupComplete never fires', async () => {
			// Override GoogleGenAI constructor to return a connect that never fires setupComplete
			const { GoogleGenAI } = await import('@google/genai');
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: {
					connect: vi.fn(async () => mockSession),
				},
			}));

			const transport = new GeminiLiveTransport({ apiKey: 'test-key', connectTimeoutMs: 50 }, {});
			await expect(transport.connect()).rejects.toThrow('timed out');
		});

		it(
			'rejects with timeout when the SDK dial itself never settles (failed DNS/socket)',
			{ timeout: 1000 },
			async () => {
				// live.connect()'s promise is resolve-only in the SDK — on a failed
				// dial (getaddrinfo ENOTFOUND) it never settles, so the deadline must
				// cover the dial, not just the setupComplete wait.
				const { GoogleGenAI } = await import('@google/genai');
				(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
					live: {
						connect: vi.fn(() => new Promise(() => {})),
					},
				}));

				const transport = new GeminiLiveTransport({ apiKey: 'test-key', connectTimeoutMs: 50 }, {});
				await expect(transport.connect()).rejects.toThrow('timed out');
			},
		);

		it('a superseded dial closing late does not fire the live onClose callback', async () => {
			// Real-SDK shape: closing a session fires that dial's onclose. A dial
			// abandoned by timeout is closed when it finally resolves; that stale
			// close must not reach the session's handleTransportClose, which would
			// mistake it for the CURRENT connection and tear down a healthy
			// replacement.
			const { GoogleGenAI } = await import('@google/genai');
			let resolveDial1!: (s: unknown) => void;
			let dial1Callbacks!: Record<string, (...args: unknown[]) => void>;
			const connectFn = vi.fn();
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));
			connectFn
				.mockImplementationOnce((params: Record<string, unknown>) => {
					dial1Callbacks = params.callbacks as typeof dial1Callbacks;
					return new Promise((resolve) => {
						resolveDial1 = resolve;
					});
				})
				// Dial 2 behaves like a healthy socket: session + its own setupComplete.
				.mockImplementationOnce(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'live_sid' } }), 1);
					return mockSession;
				});

			const transport = new GeminiLiveTransport({ apiKey: 'test-key', connectTimeoutMs: 50 }, {});
			const onCloseSpy = vi.fn();
			transport.onClose = onCloseSpy;

			// Dial 1 times out.
			await expect(transport.connect()).rejects.toThrow('timed out');

			// Dial 2 succeeds (default mock: resolves + fires setupComplete).
			await transport.connect();
			expect(transport.isConnected).toBe(true);

			// Dial 1's socket finally opens; the transport closes the orphan and
			// the SDK fires dial 1's onclose — as the real websocket would.
			const dial1Session = {
				close: vi.fn(() => dial1Callbacks.onclose?.({ code: 1000, reason: 'stale' })),
			};
			resolveDial1(dial1Session);
			await new Promise((r) => setTimeout(r, 10));

			expect(dial1Session.close).toHaveBeenCalled();
			expect(onCloseSpy).not.toHaveBeenCalled();
		});

		it(
			"a superseded dial's setupComplete cannot satisfy the current dial's setup wait",
			{ timeout: 1000 },
			async () => {
				// setupResolver is per-connect state; a stale dial's late
				// setupComplete must not resolve the replacement dial's wait.
				const { GoogleGenAI } = await import('@google/genai');
				let dial1Callbacks!: Record<string, (...args: unknown[]) => void>;
				const connectFn = vi.fn();
				(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
					live: { connect: connectFn },
				}));
				connectFn
					.mockImplementationOnce((params: Record<string, unknown>) => {
						dial1Callbacks = params.callbacks as typeof dial1Callbacks;
						return new Promise(() => {});
					})
					// Dial 2 resolves a session but its own setupComplete never fires.
					.mockImplementationOnce(async () => mockSession);

				const transport = new GeminiLiveTransport(
					{ apiKey: 'test-key', connectTimeoutMs: 100 },
					{},
				);
				await expect(transport.connect()).rejects.toThrow('timed out');

				const secondDial = transport.connect();
				// The stale dial's socket delivers a setupComplete mid-wait.
				dial1Callbacks.onmessage?.({ setupComplete: { sessionId: 'stale_sid' } });

				// Dial 2 must still time out — the stale ack proves nothing about it.
				await expect(secondDial).rejects.toThrow('timed out');
			},
		);
	});

	describe('connection lifecycle events', () => {
		type Ev = { kind: string; connectAttemptId: string } & Record<string, unknown>;

		it('a clean connect emits attempt (handleSupplied=false) then setup-ok with the generation', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			await transport.connect();

			expect(events.map((e) => e.kind)).toEqual(['attempt', 'setup-ok']);
			expect(events[0].handleSupplied).toBe(false);
			expect(events[1].transportGeneration).toBe(1);
			expect(events[0].connectAttemptId).toBe(events[1].connectAttemptId);
		});

		it('a dial with a stored resumption handle reports handleSupplied=true', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', resumptionHandle: 'handle_1' },
				{ onConnectionLifecycle: (e) => events.push(e as Ev) },
			);
			await transport.connect();
			expect(events[0]).toMatchObject({ kind: 'attempt', handleSupplied: true });
		});

		it('a close after setup is generation-close carrying the generation', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (e?: unknown) => void>;
			cbs.onclose({ code: 1011, reason: 'internal error' });

			const last = events.at(-1) as Ev;
			expect(last.kind).toBe('generation-close');
			expect(last.transportGeneration).toBe(1);
			expect(last.code).toBe(1011);
		});

		it('a socket that dies BEFORE setupComplete emits attempt-close (no generation) then setup-failed', async () => {
			// Manual dial control, same pattern as the stale-dial tests: the dial
			// resolves a session but setupComplete never arrives; the socket closes.
			const { GoogleGenAI } = await import('@google/genai');
			let dialCallbacks!: Record<string, (...args: unknown[]) => void>;
			const connectFn = vi.fn().mockImplementationOnce(async (params: Record<string, unknown>) => {
				dialCallbacks = params.callbacks as typeof dialCallbacks;
				return mockSession;
			});
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));

			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', connectTimeoutMs: 60 },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			const pending = transport.connect();
			await new Promise((r) => setTimeout(r, 5));
			dialCallbacks.onclose?.({ code: 1006, reason: 'died during setup' });
			await expect(pending).rejects.toThrow('timed out');

			const kinds = events.map((e) => e.kind);
			expect(kinds).toEqual(['attempt', 'attempt-close', 'setup-failed']);
			const close = events[1];
			expect(close.code).toBe(1006);
			expect(Object.hasOwn(close, 'transportGeneration')).toBe(false);
			// Both events describe one attempt — correlated by id, not by guesswork.
			expect(close.connectAttemptId).toBe(events[0].connectAttemptId);
			expect(events[2].connectAttemptId).toBe(events[0].connectAttemptId);
		});

		it('a superseded dial emits no setup-failed — stale-dial fencing covers failures too', async () => {
			const { GoogleGenAI } = await import('@google/genai');
			const connectFn = vi.fn();
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));
			connectFn
				// Dial 1 never resolves; dial 2 is healthy.
				.mockImplementationOnce(() => new Promise(() => {}))
				.mockImplementationOnce(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'sid_2' } }), 1);
					return mockSession;
				});

			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', connectTimeoutMs: 60 },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			const first = transport.connect();
			first.catch(() => {}); // outcome asserted below; silence unhandled-rejection
			await new Promise((r) => setTimeout(r, 5));
			await transport.connect(); // supersedes dial 1
			await expect(first).rejects.toThrow('timed out');

			const kinds = events.map((e) => `${e.kind}:${e.connectAttemptId}`);
			expect(kinds).toEqual(['attempt:att_1', 'attempt:att_2', 'setup-ok:att_2']);
		});

		it('reconnect() emits generation-close for the socket it closes locally, exactly once', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			await transport.connect();
			await transport.reconnect({ resumptionHandle: undefined, conversationHistory: [] });

			const closes = events.filter((e) => e.kind === 'generation-close');
			expect(closes).toHaveLength(1);
			expect(closes[0]).toMatchObject({
				connectAttemptId: 'att_1',
				transportGeneration: 1,
				code: 1000,
				reason: 'local disconnect',
			});
			// The reconnect's own lineage continues: attempt + setup-ok for att_2.
			expect(events.map((e) => e.kind)).toEqual([
				'attempt',
				'setup-ok',
				'generation-close',
				'attempt',
				'setup-ok',
			]);
		});

		it('a throwing observer cannot interrupt the connection state machine', async () => {
			// The three review scenarios in one lifecycle: a throwing attempt
			// observer must not prevent dialing; a throwing setup-ok observer must
			// not fake a timeout; a throwing close observer must not keep
			// disconnect() from closing the socket.
			const seen: string[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{
					onConnectionLifecycle: (e) => {
						seen.push(e.kind);
						throw new Error(`observer failed on ${e.kind}`);
					},
				},
			);

			await transport.connect(); // resolves despite attempt+setup-ok throwing
			expect(transport.isConnected).toBe(true);

			await transport.disconnect(); // completes despite generation-close throwing
			expect(mockSession.close).toHaveBeenCalled();
			expect(transport.isConnected).toBe(false);

			expect(seen).toEqual(['attempt', 'setup-ok', 'generation-close']);
		});

		it('property-form callback fires too — the path VoiceSession wires', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onConnectionLifecycle = (e) => events.push(e as Ev);
			await transport.connect();
			expect(events.map((e) => e.kind)).toEqual(['attempt', 'setup-ok']);
		});
	});

	describe('upstream diagnostics', () => {
		const B64 = 'AAAA'.repeat(30); // 120 b64 chars -> 90 raw bytes

		it('counts a queued audio send with split raw/wire byte accounting', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			transport.sendAudio(B64);

			const a = transport.getDiagnostics().upstream.audio;
			expect(a.attempted).toBe(1);
			expect(a.queued).toBe(1);
			expect(a.attemptedRawBytes).toBe(90);
			expect(a.attemptedWireBytesEstimate).toBe(120);
			expect(a.queuedRawBytes).toBe(90);
			expect(a.lastQueuedAt).not.toBeNull();
			expect(a.lastThrewAt).toBeNull();
		});

		it('a send with no session is attempted+skipped, never queued', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.sendAudio(B64); // never connected

			const a = transport.getDiagnostics().upstream.audio;
			expect(a.attempted).toBe(1);
			expect(a.skippedNoSession).toBe(1);
			expect(a.queued).toBe(0);
			expect(a.lastSkippedAt).not.toBeNull();
		});

		it('both text APIs land in the text slot; empty text is skippedEmpty', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			transport.sendContent([{ role: 'user', text: 'hello' }]);
			transport.sendClientContent([{ role: 'user', parts: [{ text: 'world' }] }]);
			transport.sendContent([{ role: 'user', text: '' }]);

			const t = transport.getDiagnostics().upstream.text;
			expect(t.attempted).toBe(3);
			expect(t.queued).toBe(2);
			expect(t.skippedEmpty).toBe(1);
			// UTF-8 bytes for text: 'hello' + 'world'
			expect(t.queuedRawBytes).toBe(10);
		});

		it('sendFile slots by destination: image->video, audio/*->audio, other->unsupportedMime', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			transport.sendFile(B64, 'image/jpeg');
			transport.sendFile(B64, 'audio/wav');
			transport.sendFile(B64, 'application/pdf');

			const d = transport.getDiagnostics().upstream;
			expect(d.video.queued).toBe(1);
			expect(d.audio.queued).toBe(1);
			expect(d.video.unsupportedMime).toBe(1);
			// The unsupported attempt landed on video (2 attempts: jpeg + pdf) and
			// exactly one guard outcome fired for it.
			expect(d.video.attempted).toBe(2);
		});

		it('a throwing send counts threw, rethrows, and never counts queued', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			mockSession.sendRealtimeInput.mockImplementationOnce(() => {
				throw new Error('socket write failed');
			});

			expect(() => transport.sendAudio(B64)).toThrow('socket write failed');
			const a = transport.getDiagnostics().upstream.audio;
			expect(a.attempted).toBe(1);
			expect(a.threw).toBe(1);
			expect(a.queued).toBe(0);
			expect(a.lastThrewAt).not.toBeNull();
		});

		it('counters reset on a new generation — a new socket starts at zero', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			transport.sendAudio(B64);
			expect(transport.getDiagnostics().transportGeneration).toBe(1);
			expect(transport.getDiagnostics().upstream.audio.queued).toBe(1);

			// A new connection's setupComplete is the generation boundary.
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ setupComplete: { sessionId: 'sid_2' } });

			const d = transport.getDiagnostics();
			expect(d.transportGeneration).toBe(2);
			expect(d.upstream.audio.queued).toBe(0);
			expect(d.upstream.audio.lastQueuedAt).toBeNull();
		});

		it('reconnect replay traffic hits the counters — injection is not invisible', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			await transport.reconnect({
				resumptionHandle: undefined,
				conversationHistory: [
					{ type: 'text', role: 'user', text: 'earlier question' },
					{ type: 'text', role: 'assistant', text: 'earlier answer' },
					{ type: 'file', base64Data: 'AAAA'.repeat(30), mimeType: 'image/png' },
				],
			});

			// Counters reset at the reconnect's setup, so what remains IS the replay.
			const d = transport.getDiagnostics().upstream;
			expect(d.text.queued).toBe(1);
			expect(d.text.queuedRawBytes).toBeGreaterThan(0);
			expect(d.video.queued).toBe(1);
			expect(d.video.queuedRawBytes).toBe(90);
			// Replay goes through sendFile, so the wire uses the supported video
			// slot — not the deprecated generic `media` field — and the counter
			// genuinely describes what was sent.
			const videoSends = mockSession.sendRealtimeInput.mock.calls.filter(
				(c: unknown[]) => (c[0] as Record<string, unknown>).video,
			);
			expect(videoSends).toHaveLength(1);
			const mediaSends = mockSession.sendRealtimeInput.mock.calls.filter(
				(c: unknown[]) => (c[0] as Record<string, unknown>).media,
			);
			expect(mediaSends).toHaveLength(0);
		});

		it('an unsupported replay file counts unsupportedMime, not a queued video send', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			await transport.reconnect({
				resumptionHandle: undefined,
				conversationHistory: [{ type: 'file', base64Data: 'AAAA', mimeType: 'application/pdf' }],
			});

			const d = transport.getDiagnostics().upstream;
			expect(d.video.unsupportedMime).toBe(1);
			expect(d.video.queued).toBe(0);
		});

		it('getDiagnostics returns a snapshot, not a live reference', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			const snap = transport.getDiagnostics();
			transport.sendAudio(B64);
			expect(snap.upstream.audio.attempted).toBe(0);
			expect(transport.getDiagnostics().upstream.audio.attempted).toBe(1);
		});
	});

	describe('sendAudio', () => {
		it('calls session.sendRealtimeInput with correct format', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendAudio('base64audiodata');

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
				audio: { data: 'base64audiodata', mimeType: 'audio/pcm;rate=16000' },
			});
		});

		it('does nothing if not connected', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.sendAudio('data');
			expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
		});
	});

	describe('sendToolResponse', () => {
		it('sends tool response with scheduling', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendToolResponse(
				[{ id: 'fc_1', name: 'search', response: { results: [] } }],
				'WHEN_IDLE',
			);

			expect(mockSession.sendToolResponse).toHaveBeenCalledWith({
				functionResponses: [{ id: 'fc_1', name: 'search', response: { results: [] } }],
			});
		});
	});

	describe('sendClientContent', () => {
		it('routes single-turn text to sendRealtimeInput', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendClientContent([{ role: 'user', parts: [{ text: 'hello' }] }]);

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({ text: 'hello' });
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});

		it('concatenates multi-turn text with role prefixes', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendClientContent([
				{ role: 'user', parts: [{ text: 'hello' }] },
				{ role: 'model', parts: [{ text: 'hi there' }] },
			]);

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
				text: 'user: hello\nmodel: hi there',
			});
		});

		it('skips empty turns', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendClientContent([{ role: 'user', parts: [] }]);

			expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
		});
	});

	describe('message dispatch', () => {
		it('dispatches setupComplete', async () => {
			const onSetupComplete = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onSetupComplete });
			await transport.connect();

			// Simulate message from server
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ setupComplete: { sessionId: 'sid_1' } });

			expect(onSetupComplete).toHaveBeenCalledWith('sid_1');
		});

		it('dispatches audio output', async () => {
			const onAudioOutput = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onAudioOutput });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});

			expect(onAudioOutput).toHaveBeenCalledWith('audio_b64');
		});

		it('dispatches toolCall', async () => {
			const onToolCall = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onToolCall });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				toolCall: {
					functionCalls: [{ id: 'fc_1', name: 'search', args: { q: 'test' } }],
				},
			});

			expect(onToolCall).toHaveBeenCalledWith([
				{ id: 'fc_1', name: 'search', args: { q: 'test' } },
			]);
		});

		it('dispatches toolCallCancellation', async () => {
			const onToolCallCancellation = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onToolCallCancellation });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ toolCallCancellation: { ids: ['fc_1', 'fc_2'] } });

			expect(onToolCallCancellation).toHaveBeenCalledWith(['fc_1', 'fc_2']);
		});

		it('dispatches turnComplete', async () => {
			const onTurnComplete = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onTurnComplete });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ serverContent: { turnComplete: true } });

			expect(onTurnComplete).toHaveBeenCalledOnce();
		});

		it('dispatches goAway', async () => {
			const onGoAway = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onGoAway });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ goAway: { timeLeft: '30s' } });

			expect(onGoAway).toHaveBeenCalledWith('30s');
		});

		it('dispatches resumptionUpdate', async () => {
			const onResumptionUpdate = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onResumptionUpdate });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'h_new', resumable: true },
			});

			expect(onResumptionUpdate).toHaveBeenCalledWith('h_new', true);
		});

		it('stores a resumable handle and resumes with it on reconnect (sutando-meeting#129)', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'h_live', resumable: true },
			});

			mockSession.sendRealtimeInput.mockClear();
			await transport.reconnect({});

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'h_live' });
			// Resumed session restores server-side context — no history replay.
			expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
		});

		it('clears the stored handle on a non-resumable update (sutando-meeting#129)', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'h_live', resumable: true },
			});
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'h_dead', resumable: false },
			});

			await transport.reconnect({});

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({});
		});

		it('dispatches groundingMetadata', async () => {
			const onGroundingMetadata = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onGroundingMetadata });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: {
					groundingMetadata: {
						searchEntryPoint: { renderedContent: '<div>results</div>' },
						groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
					},
				},
			});

			expect(onGroundingMetadata).toHaveBeenCalledWith({
				searchEntryPoint: { renderedContent: '<div>results</div>' },
				groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
			});
		});

		it('dispatches transcriptions', async () => {
			const onInputTranscription = vi.fn();
			const onOutputTranscription = vi.fn();
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onInputTranscription, onOutputTranscription },
			);
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: { inputTranscription: { text: 'hello' } },
			});
			cbs.onmessage({
				serverContent: { outputTranscription: { text: 'hi there' } },
			});

			expect(onInputTranscription).toHaveBeenCalledWith('hello');
			expect(onOutputTranscription).toHaveBeenCalledWith('hi there');
		});
	});

	describe('disconnect', () => {
		it('closes session and sets isConnected to false', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			expect(transport.isConnected).toBe(true);

			await transport.disconnect();
			expect(transport.isConnected).toBe(false);
			expect(mockSession.close).toHaveBeenCalled();
		});
	});

	// =========================================================================
	// LLMTransport interface tests
	// =========================================================================

	describe('LLMTransport capabilities', () => {
		it('reports Gemini capabilities', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			expect(transport.capabilities).toEqual({
				messageTruncation: false,
				turnDetection: true,
				userTranscription: true,
				inPlaceSessionUpdate: false,
				sessionResumption: true,
				contextCompression: true,
				groundingMetadata: true,
			});
		});

		it('reports Gemini audio format', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			expect(transport.audioFormat).toEqual({
				inputSampleRate: 16000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
			});
		});
	});

	describe('sendContent', () => {
		it('concatenates multi-turn ContentTurn with role prefixes (assistant → model)', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendContent([
				{ role: 'user', text: 'hello' },
				{ role: 'assistant', text: 'hi there' },
			]);

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
				text: 'user: hello\nmodel: hi there',
			});
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});

		it('sends single turn without role prefix', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendContent([{ role: 'user', text: 'hello' }], false);

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({ text: 'hello' });
		});
	});

	describe('sendFile', () => {
		it('routes image/* to sendRealtimeInput({video})', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendFile('base64imgdata', 'image/png');

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
				video: { data: 'base64imgdata', mimeType: 'image/png' },
			});
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});

		it('routes audio/* to sendRealtimeInput({audio})', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendFile('base64audiodata', 'audio/mp3');

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
				audio: { data: 'base64audiodata', mimeType: 'audio/mp3' },
			});
		});

		it('warns and no-ops for unsupported mimeType', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			transport.sendFile('base64pdfdata', 'application/pdf');

			expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('unsupported mimeType "application/pdf"'),
			);
			warnSpy.mockRestore();
		});
	});

	describe('sendToolResult', () => {
		it('wraps in functionResponses format', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendToolResult({
				id: 'fc_1',
				name: 'search',
				result: { results: ['a', 'b'] },
				scheduling: 'when_idle',
			});

			expect(mockSession.sendToolResponse).toHaveBeenCalledWith({
				functionResponses: [{ id: 'fc_1', name: 'search', response: { results: ['a', 'b'] } }],
			});
		});
	});

	describe('transferSession', () => {
		it('disconnects, reconnects, and replays conversation history via sendRealtimeInput', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			mockSession.sendRealtimeInput.mockClear();
			mockSession.sendClientContent.mockClear();

			await transport.transferSession(
				{ instructions: 'New agent', tools: [] },
				{
					conversationHistory: [
						{ type: 'text', role: 'user', text: 'hello' },
						{ type: 'text', role: 'assistant', text: 'hi' },
					],
				},
			);

			// Should have reconnected (close + connect)
			expect(mockSession.close).toHaveBeenCalled();

			// Replay is now via sendRealtimeInput with role-prefixed text
			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
				text: 'user: hello\nmodel: hi',
			});
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});
	});

	describe('LLMTransport callback properties', () => {
		it('fires callback properties alongside constructor callbacks', async () => {
			const constructorCb = vi.fn();
			const propertyCb = vi.fn();

			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onTurnComplete: constructorCb },
			);
			transport.onTurnComplete = propertyCb;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ serverContent: { turnComplete: true } });

			expect(constructorCb).toHaveBeenCalledOnce();
			expect(propertyCb).toHaveBeenCalledOnce();
		});

		it('fires onSessionReady alongside constructor onSetupComplete', async () => {
			const onSetupComplete = vi.fn();
			const onSessionReady = vi.fn();

			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onSetupComplete });
			transport.onSessionReady = onSessionReady;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ setupComplete: { sessionId: 'sid_dual' } });

			expect(onSetupComplete).toHaveBeenCalledWith('sid_dual');
			expect(onSessionReady).toHaveBeenCalledWith('sid_dual');
		});
	});

	describe('no-op methods', () => {
		it('commitAudio and clearAudio are no-ops', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			// Should not throw
			transport.commitAudio();
			transport.clearAudio();
		});

		it('triggerGeneration is a no-op', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.triggerGeneration('some instructions');
		});
	});

	describe('onModelTurnStart', () => {
		it('fires on first modelTurn.parts per turn', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onModelTurnStart });
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// First modelTurn — should fire
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});

			// Constructor callback + property callback = 2 calls
			expect(onModelTurnStart).toHaveBeenCalledTimes(2);
		});

		it('fires only once per turn (not on subsequent modelTurn.parts)', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// First modelTurn — fires
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'chunk1' } }] },
				},
			});
			// Second modelTurn in same turn — does NOT fire again
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'chunk2' } }] },
				},
			});

			expect(onModelTurnStart).toHaveBeenCalledOnce();
		});

		it('fires on first toolCall if no audio preceded it', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			cbs.onmessage({
				toolCall: {
					functionCalls: [{ id: 'fc_1', name: 'search', args: { q: 'test' } }],
				},
			});

			expect(onModelTurnStart).toHaveBeenCalledOnce();
		});

		it('does not fire on toolCall if audio already fired it', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// Audio fires first
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});
			expect(onModelTurnStart).toHaveBeenCalledOnce();

			// Tool call should not fire again
			cbs.onmessage({
				toolCall: {
					functionCalls: [{ id: 'fc_1', name: 'search', args: {} }],
				},
			});
			expect(onModelTurnStart).toHaveBeenCalledOnce();
		});

		it('resets on turnComplete so next turn fires again', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// Turn 1
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});
			cbs.onmessage({ serverContent: { turnComplete: true } });

			// Turn 2
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});

			expect(onModelTurnStart).toHaveBeenCalledTimes(2);
		});
	});
});

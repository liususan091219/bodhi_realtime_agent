// SPDX-License-Identifier: MIT

import type { IncomingMessage } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { AudioBuffer } from './audio-buffer.js';

/** Callbacks fired by ClientTransport when client events occur. */
export interface ClientTransportCallbacks {
	/** Raw PCM audio data received from the client WebSocket (binary frames). */
	onAudioFromClient?(data: Buffer): void;
	/** A JSON message received from the client WebSocket (text frames). */
	onJsonFromClient?(message: Record<string, unknown>): void;
	/** A REAL client WebSocket connection was established (never fired for probe/verify roles). */
	onClientConnected?(): void;
	/** The REAL client WebSocket disconnected (never fired for probe/verify roles). */
	onClientDisconnected?(): void;
	/** An image was uploaded by the client (base64-encoded). */
	onImageUpload?(imageBase64: string, mimeType: string): void;
	/** A verification-role connection (`?verify=1`) attached. The embedder may use
	 *  this narrow hook to wake upstream, but MUST NOT run real-client
	 *  connect side effects here (Y3 behavioral isolation). */
	onVerifierConnected?(): void;
	/** The verification-role connection detached (clean close or preemption). */
	onVerifierDisconnected?(): void;
}

/** Optional constructor behavior for ClientTransport. */
export interface ClientTransportOptions {
	/** Supplies the JSON state frame sent to `?probe=1` connections. When absent,
	 *  probes are upgraded and closed (code 1000) without a frame (L1-only probe). */
	probeState?: () => object;
}

/** Connection roles recognized from the request URL query (owner-decided mechanism, 2026-08-05). */
export type ClientConnectionRole = 'real' | 'verify';

/** Application close code: a second real client (or a verifier) was rejected
 *  because a real client is attached (V4/W5). */
export const CLOSE_CODE_CLIENT_BUSY = 4409;
/** Close reason paired with {@link CLOSE_CODE_CLIENT_BUSY}. */
export const CLOSE_REASON_CLIENT_BUSY = 'client-busy';

/** Application close code: the incumbent real client was closed because a
 *  `?takeover=1` challenger completed the user-confirmed takeover handshake (W5). */
export const CLOSE_CODE_SUPERSEDED_BY_TAKEOVER = 4410;
/** Close reason paired with {@link CLOSE_CODE_SUPERSEDED_BY_TAKEOVER}. */
export const CLOSE_REASON_SUPERSEDED_BY_TAKEOVER = 'superseded-by-takeover';

/** Application close code: an incumbent verification-role connection was
 *  preempted by an arriving real client (X2) — the verifier's owner requeues. */
export const CLOSE_CODE_VERIFIER_PREEMPTED = 4411;
/** Close reason paired with {@link CLOSE_CODE_VERIFIER_PREEMPTED}. */
export const CLOSE_REASON_VERIFIER_PREEMPTED = 'verifier-preempted';

/**
 * WebSocket server that bridges a client audio app to the framework.
 *
 * Multiplexes two message types on the same WebSocket connection:
 * - **Binary frames**: Raw PCM audio (forwarded via `onAudioFromClient` or buffered during transfers).
 * - **Text frames**: JSON messages for GUI events (`onJsonFromClient`).
 *
 * Buffering mode (`startBuffering`/`stopBuffering`) only affects binary audio frames.
 * Text frames are always delivered immediately.
 *
 * Pre-client interception (owner-decided mechanism, 2026-08-05) — recognized
 * from the upgrade request URL query, BEFORE any `client` assignment:
 * - `?probe=1` — health probe: upgrade completes, one JSON text frame from
 *   `options.probeState` is sent (if provided), then close 1000. Probe sockets
 *   never touch the attached client, never fire connect/disconnect callbacks,
 *   and are excluded from all client accounting.
 * - `?takeover=1` — user-confirmed takeover: an incumbent real client is closed
 *   with 4410 `superseded-by-takeover`, then the challenger attaches as real.
 * - `?verify=1` — low-priority verification role: rejected 4409 `client-busy`
 *   while a real client is attached; preempted (4411 `verifier-preempted`) when
 *   a real client arrives. Fires `onVerifierConnected`/`onVerifierDisconnected`
 *   only — never the real-client callbacks — and never counts as attached.
 */
export class ClientTransport {
	private wss: WebSocketServer | null = null;
	private client: WebSocket | null = null;
	private clientRole: ClientConnectionRole | null = null;
	private audioBuffer = new AudioBuffer();
	private _buffering = false;

	constructor(
		private port: number,
		private callbacks: ClientTransportCallbacks,
		private host = '0.0.0.0',
		private listenTimeoutMs = 10_000,
		private options: ClientTransportOptions = {},
	) {}

	async start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`ClientTransport listen timed out after ${this.listenTimeoutMs}ms`));
			}, this.listenTimeoutMs);

			this.wss = new WebSocketServer({ port: this.port, host: this.host });

			this.wss.on('listening', () => {
				clearTimeout(timer);
				resolve();
			});

			this.wss.on('connection', (ws, req) => {
				this.handleConnection(ws, req);
			});
		});
	}

	/** Pre-client interception: classify the connection BEFORE any `client` assignment. */
	private handleConnection(ws: WebSocket, req: IncomingMessage): void {
		const params = new URL(req.url ?? '/', 'ws://localhost').searchParams;

		// (a) Probe: upgrade + optional state frame + close 1000. Never attaches,
		// never fires callbacks, excluded from client accounting.
		if (params.get('probe') === '1') {
			this.handleProbe(ws);
			return;
		}

		const takeover = params.get('takeover') === '1';
		const role: ClientConnectionRole = params.get('verify') === '1' ? 'verify' : 'real';

		if (this.client) {
			if (this.clientRole === 'real') {
				if (role === 'real' && takeover) {
					// (b) Takeover handshake: close the incumbent with a distinct
					// close, then attach the challenger.
					this.detachIncumbent(
						CLOSE_CODE_SUPERSEDED_BY_TAKEOVER,
						CLOSE_REASON_SUPERSEDED_BY_TAKEOVER,
					);
				} else {
					// (b)/(c) A real client is attached: reject a second real client
					// and any verifier with the stable client-busy close.
					this.rejectBusy(ws);
					return;
				}
			} else {
				// Incumbent is a verifier (low-priority role).
				if (role === 'real') {
					// (c) Preempt the verifier — distinct close so its owner requeues.
					this.detachIncumbent(CLOSE_CODE_VERIFIER_PREEMPTED, CLOSE_REASON_VERIFIER_PREEMPTED);
				} else {
					// Second verifier: only one connection at a time — requeue.
					this.rejectBusy(ws);
					return;
				}
			}
		}

		this.attach(ws, role);
	}

	private handleProbe(ws: WebSocket): void {
		ws.on('error', () => {
			// Prevent unhandled error crash on the probe socket
		});
		if (this.options.probeState) {
			try {
				ws.send(JSON.stringify(this.options.probeState()));
			} catch {
				// probeState threw or send failed — still close cleanly (L1-only result)
			}
		}
		ws.close(1000);
	}

	private rejectBusy(ws: WebSocket): void {
		ws.on('error', () => {
			// Prevent unhandled error crash on the rejected socket
		});
		ws.close(CLOSE_CODE_CLIENT_BUSY, CLOSE_REASON_CLIENT_BUSY);
	}

	/** Detach the incumbent connection deliberately (takeover/preemption): fire its
	 *  role-appropriate disconnect callback synchronously, then close its socket.
	 *  The socket's own 'close' handler is a no-op afterwards (client no longer === ws). */
	private detachIncumbent(code: number, reason: string): void {
		const incumbent = this.client;
		const incumbentRole = this.clientRole;
		this.client = null;
		this.clientRole = null;
		if (incumbentRole === 'real') {
			this.callbacks.onClientDisconnected?.();
		} else if (incumbentRole === 'verify') {
			this.callbacks.onVerifierDisconnected?.();
		}
		incumbent?.close(code, reason);
	}

	private attach(ws: WebSocket, role: ClientConnectionRole): void {
		// Attach event handlers BEFORE setting this.client to avoid
		// a race where messages arrive before handlers are registered.
		ws.on('message', (data: Buffer, isBinary: boolean) => {
			// Verification-role isolation (Y3): a verifier observes outbound state
			// only — its inbound frames must never reach user-side callbacks.
			if (role !== 'real') return;
			if (isBinary) {
				if (this._buffering) {
					this.audioBuffer.push(data);
				} else {
					this.callbacks.onAudioFromClient?.(data);
				}
			} else {
				try {
					const message = JSON.parse(data.toString()) as Record<string, unknown>;
					this.callbacks.onJsonFromClient?.(message);
				} catch {
					// Ignore malformed JSON
				}
			}
		});

		ws.on('close', () => {
			// Already detached deliberately (takeover/preemption) or replaced.
			if (this.client !== ws) return;
			this.client = null;
			this.clientRole = null;
			if (role === 'real') {
				this.callbacks.onClientDisconnected?.();
			} else {
				this.callbacks.onVerifierDisconnected?.();
			}
		});

		ws.on('error', () => {
			// Prevent unhandled error crash — 'close' event will follow
		});

		this.client = ws;
		this.clientRole = role;
		if (role === 'real') {
			this.callbacks.onClientConnected?.();
		} else {
			this.callbacks.onVerifierConnected?.();
		}
	}

	async stop(): Promise<void> {
		this._buffering = false;
		this.audioBuffer.clear();
		if (this.client) {
			this.client.removeAllListeners();
			this.client.close();
			this.client = null;
			this.clientRole = null;
		}
		if (this.wss) {
			return new Promise((resolve) => {
				this.wss?.close(() => {
					this.wss = null;
					resolve();
				});
			});
		}
	}

	/** Send raw PCM audio to the client as a binary frame. */
	sendAudioToClient(data: Buffer): void {
		if (this.client?.readyState === 1) {
			this.client.send(data);
		}
	}

	/** Send a JSON message to the client as a text frame. */
	sendJsonToClient(message: Record<string, unknown>): void {
		if (this.client?.readyState === 1) {
			this.client.send(JSON.stringify(message));
		}
	}

	startBuffering(): void {
		this._buffering = true;
		this.audioBuffer.clear();
	}

	stopBuffering(): Buffer[] {
		this._buffering = false;
		return this.audioBuffer.drain();
	}

	/** True when a REAL client is attached and open. Verifier and probe
	 *  connections never count (client accounting is real-clients-only). */
	get isClientConnected(): boolean {
		return this.clientRole === 'real' && this.client?.readyState === 1;
	}

	/** True when a verification-role (`?verify=1`) connection is attached and open. */
	get isVerifierConnected(): boolean {
		return this.clientRole === 'verify' && this.client?.readyState === 1;
	}

	/** Role of the currently attached connection, or null when none. */
	get attachedRole(): ClientConnectionRole | null {
		return this.client ? this.clientRole : null;
	}

	get buffering(): boolean {
		return this._buffering;
	}
}

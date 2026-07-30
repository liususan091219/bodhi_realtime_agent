// SPDX-License-Identifier: MIT

/**
 * Shadow-STT divergence detection — the pure half of the dual-transcription
 * feature (Susan 2026-07-30 "做").
 *
 * Motivation: the Live model's built-in inputAudioTranscription reports what
 * the MODEL heard — when it mishears ("what's this" → "what's the news",
 * observed live 2026-07-30), the transcript and the answer are consistent
 * with each other and the error is invisible. A second, batch STT pass over
 * the same audio is structurally better placed (it sees the complete
 * utterance) and disagreement between the two is the only reliable tell.
 *
 * This module owns normalization + comparison only. The session wires a
 * `shadowSttProvider` (e.g. GeminiBatchSTTProvider) whose transcript is
 * compared against the accumulated built-in transcription for the turn.
 * V1 is observation-only: divergence is logged / surfaced via a hook, and
 * NOTHING about what the model heard, said, or stored changes.
 */

/** Lowercase, strip punctuation (keep letters/digits incl. CJK), collapse
 *  whitespace — so "Hi, Lucy!" vs "hi lucy" is NOT a divergence. */
export function normalizeTranscript(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export interface DivergenceResult {
	diverged: boolean;
	/** Why not / why so — one of: 'match' | 'diverged' | 'empty-live' | 'empty-shadow' | 'both-empty' */
	reason: 'match' | 'diverged' | 'empty-live' | 'empty-shadow' | 'both-empty';
	normalizedLive: string;
	normalizedShadow: string;
}

/**
 * Compare the built-in (live) transcript against the shadow transcript.
 * Empty sides never count as divergence — a missing transcript is a
 * coverage gap, not evidence of a mishear (and the shadow provider skips
 * sub-threshold audio by design, e.g. GeminiBatchSTTProvider's RMS gate).
 */
export function compareTranscripts(liveText: string, shadowText: string): DivergenceResult {
	const live = normalizeTranscript(liveText);
	const shadow = normalizeTranscript(shadowText);
	if (!live && !shadow)
		return {
			diverged: false,
			reason: 'both-empty',
			normalizedLive: live,
			normalizedShadow: shadow,
		};
	if (!live)
		return {
			diverged: false,
			reason: 'empty-live',
			normalizedLive: live,
			normalizedShadow: shadow,
		};
	if (!shadow)
		return {
			diverged: false,
			reason: 'empty-shadow',
			normalizedLive: live,
			normalizedShadow: shadow,
		};
	// Containment = streaming truncation artifact (the live side often carries
	// only a prefix/suffix of the utterance), not a mishear — learned from the
	// 2026-07-30 log-mining pass where 22% of "divergences" were containment.
	if (live === shadow || live.includes(shadow) || shadow.includes(live)) {
		return { diverged: false, reason: 'match', normalizedLive: live, normalizedShadow: shadow };
	}
	return { diverged: true, reason: 'diverged', normalizedLive: live, normalizedShadow: shadow };
}

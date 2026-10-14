import { onBrainFrame, sendToRobot, type RobotPayload } from '../utils/websocketServer';
import { PdController } from '../motion/pdController';
import { Logger } from '../utils/logger';
import { initialRobotViewState, type RobotBodyState, type RobotFrame, type RobotViewState } from './robotState';
import {
    buildPopupState,
    popupRank,
    popupSignature,
    type PopupSnapshotInput,
    type PopupState,
} from './robotPopup';

export type RobotFrameListener = (frame: RobotFrame) => void;
export type PopupIssueProvider = () => Omit<PopupSnapshotInput, 'now'>;

/**
 * A verified/errored outcome stays on screen long enough to be read, but a
 * stale SUCCESS must never outlive the session that earned it.
 */
const RESOLUTION_VISIBLE_MS = 120_000;

/**
 * Robot State Publisher: Brain → canonical RobotViewState.
 *
 * Subscribes to the ONE canonical Brain frame hook, so the Webview sees
 * exactly what any body would see — no second decision, no second copy.
 * Numeric channels (expression intensity, attention strength) are shaped by a
 * PD controller toward Brain-decided targets, so the view never overshoots or
 * flaps between frames.
 */
export class RobotStatePublisher {
    private state: RobotViewState = initialRobotViewState();
    private readonly listeners = new Set<RobotFrameListener>();
    private issueProvider: PopupIssueProvider | undefined;
    /** Latest Brain-tailored caption; preferred popup message when present. */
    private lastCaptionText: string | undefined;
    /** Signature of the last emitted popup; equal content never re-emits. */
    private lastPopupSignature: string | null = null;
    /** Current popup signature suppressed by an explicit user dismiss. */
    private suppressedSignature: string | null = null;
    private readonly intensityPd = new PdController({ proportional: 14, derivative: 5 });
    private readonly attentionPd = new PdController({ proportional: 10, derivative: 4 });
    private lastFrameAt = 0;
    private unsubscribe: (() => void) | undefined;
    /** Latest raw payloads by type, for STATE_SYNC when the view connects. */
    private readonly latestPayloads = new Map<string, RobotPayload>();

    start(): void {
        if (this.unsubscribe) {
            return;
        }
        this.unsubscribe = onBrainFrame((payload) => this.onFrame(payload));
        Logger.info('ROBOT STATE', { Event: 'Publisher started' });
    }

    subscribe(listener: RobotFrameListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    getState(): RobotViewState {
        return { ...this.state };
    }

    latestPayloadTypes(): RobotPayload[] {
        return [...this.latestPayloads.values()];
    }

    setLink(link: RobotViewState['link']): void {
        this.state = { ...this.state, link, updatedAt: Date.now() };
    }

    /** Supplies the current issue/resolution evidence for the popup bar. */
    setIssueProvider(provider: PopupIssueProvider | undefined): void {
        this.issueProvider = provider;
    }

    /**
     * Records an explicit user dismiss of the current popup. The underlying
     * Brain state is untouched — only this exact popup content stays hidden
     * until something genuinely new (new matter, resolution, or change)
     * replaces it.
     */
    noteDismissed(): void {
        this.suppressedSignature = this.lastPopupSignature;
        Logger.info('ROBOT STATE', { Event: 'Popup dismissed by developer' });
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.listeners.clear();
    }

    private onFrame(payload: RobotPayload): void {
        const now = Date.now();
        const dt = this.lastFrameAt === 0 ? 1 / 60 : (now - this.lastFrameAt) / 1000;
        this.lastFrameAt = now;
        this.latestPayloads.set(payload.type, payload);
        // Our own ISSUE_STATE frames are state, not input: reduce them for the
        // view but never re-derive from them, so emission always terminates.
        if (payload.type === 'ISSUE_STATE') {
            return;
        }
        this.state = this.reduce(this.state, payload, dt, now);
        const frame: RobotFrame = { state: { ...this.state }, payload };
        for (const listener of this.listeners) {
            try {
                listener(frame);
            } catch (err) {
                Logger.info('ROBOT STATE', { Event: 'Frame listener failed', Error: String(err) });
            }
        }
        this.maybeEmitPopup(now);
    }

    /**
     * Emits the popup bar state when it materially changes. Replacement
     * policy: a more important popup always replaces; a lesser one never
     * interrupts the current important intervention; a dismissed popup stays
     * hidden until something genuinely new arrives.
     */
    private maybeEmitPopup(now: number): void {
        if (!this.issueProvider) {
            return;
        }
        let popup: PopupState;
        try {
            const input = this.issueProvider();
            // The Brain-tailored caption wins over the deterministic one-liner
            // whenever the ladder already spoke about this matter.
            const issue = input.issue && !input.issue.captionText && this.lastCaptionText
                ? { ...input.issue, captionText: this.lastCaptionText }
                : input.issue;
            popup = buildPopupState({ ...input, issue, now });
        } catch (err) {
            Logger.info('ROBOT STATE', { Event: 'Popup build failed safely', Error: String(err) });
            return;
        }
        // Stale resolutions expire instead of lingering forever.
        if (popup.visible && !popup.matter && now - popup.timestamp > RESOLUTION_VISIBLE_MS) {
            popup = { ...popup, visible: false };
        }
        const signature = popupSignature(popup);
        if (signature === this.lastPopupSignature) {
            return;
        }
        if (signature === this.suppressedSignature) {
            return;
        }
        const previous = this.lastPopup;
        if (previous && previous.visible && popup.visible && popup.matter) {
            // A lower-priority matter never interrupts the current important
            // intervention. Resolutions (no matter) always replace: they close
            // the loop rather than competing with it.
            const previousRank = previous.matter ? popupRank(previous.severity) : 0;
            if (popupRank(popup.severity) < previousRank) {
                return;
            }
        }
        this.lastPopup = popup.visible ? popup : undefined;
        this.lastPopupSignature = signature;
        try {
            sendToRobot({ type: 'ISSUE_STATE', state: popup });
        } catch (err) {
            Logger.info('ROBOT STATE', { Event: 'Popup emit failed safely', Error: String(err) });
        }
    }

    private lastPopup: PopupState | undefined;

    private reduce(previous: RobotViewState, payload: RobotPayload, dt: number, now: number): RobotViewState {
        const next: RobotViewState = { ...previous, teaching: { ...previous.teaching }, updatedAt: now };
        switch (payload.type) {
            case 'EMOTION': {
                next.emotion = payload.emotion;
                const target = typeof payload.intensity === 'number' ? payload.intensity : 1;
                next.intensity = this.intensityPd.step(previous.intensity, target, dt);
                next.bodyState = this.bodyStateForEmotion(payload.emotion, previous.bodyState);
                break;
            }
            case 'CAPTION':
                next.caption = { text: payload.text, holdMs: payload.duration };
                this.lastCaptionText = payload.text;
                if (next.bodyState === 'IDLE' || next.bodyState === 'WAITING') {
                    next.bodyState = 'EXPLAINING';
                }
                break;
            case 'TEACHING_STATE':
                next.teaching = {
                    level: payload.level,
                    matter: payload.matter,
                    concept: payload.concept,
                    recurrence: payload.recurrence,
                };
                break;
            case 'STRUGGLE_STATE':
                next.struggle = { level: payload.level, evidence: payload.evidence };
                break;
            case 'ATTENTION_TARGET': {
                const smoothed = this.attentionPd.step(previous.attention?.strength ?? 0, payload.strength, dt);
                next.attention = { targetType: payload.targetType, strength: smoothed };
                if (payload.strength > 0.35 && (next.bodyState === 'IDLE' || next.bodyState === 'WAITING')) {
                    next.bodyState = 'ATTENTION';
                }
                break;
            }
            case 'ACTION':
                if (payload.animation === 'neutral' || payload.animation === 'idle') {
                    next.bodyState = 'IDLE';
                    next.caption = undefined;
                    this.lastCaptionText = undefined;
                } else if (payload.animation === 'thinking') {
                    next.bodyState = 'THINKING';
                }
                break;
            default:
                break;
        }
        return next;
    }

    private bodyStateForEmotion(emotion: string, fallback: RobotBodyState): RobotBodyState {
        switch (emotion) {
            case 'ERROR':
                return 'FAILURE';
            case 'SPEAKING':
                return 'EXPLAINING';
            case 'THINKING':
                return 'THINKING';
            case 'HAPPY':
                return 'SUCCESS';
            case 'CONFUSED':
            case 'ALERT':
                return 'ATTENTION';
            case 'LISTENING':
                return 'WAITING';
            case 'IDLE':
                return 'IDLE';
            default:
                return fallback;
        }
    }
}

import * as vscode from 'vscode';
import type { Explanation } from "../explanation/explanationTypes";
import { ExplanationType } from "../explanation/explanationTypes";
import type { ExpressionType } from "../ai/gemini";
import type { BehaviourEvent } from "../behaviour/behaviourPublisher";
import { BehaviourAction } from "../behaviour/behaviourAction";
import { MotionType, Motion } from "./motionTypes";
import { MotionPlan } from "./motionPlan";
import { MotionPublisher } from "./motionPublisher";
import { AnimationQueue, CancelRule } from "./animationQueue";
import { Logger } from "../utils/logger";
import type { WindowAnchorPayload } from "../core/types";

const DEFAULT_TEXT_BUBBLE_DURATION = 4000;
const DEFAULT_NOD_DURATION = 1000;
const DEFAULT_SHAKE_DURATION = 1000;
const DEFAULT_RAISE_HAND_DURATION = 1500;
const DEFAULT_POINT_DURATION = 2000;
const DEFAULT_EXPRESSION_DURATION = 500;
const DEFAULT_GESTURE_DURATION = 2000;

export class MotionPlanner {
    private publisher: MotionPublisher;
    private queue: AnimationQueue;

    constructor() {
        this.publisher = new MotionPublisher();
        this.queue = new AnimationQueue();
    }

    processFromExplanation(explanation: Explanation): void {
        const plan = this.buildPlan(explanation);
        if (!plan) {
            return;
        }

        this.queue.cancel(CancelRule.SAME_TYPE, plan.sourceExplanation?.action || plan.id);
        this.queue.enqueue(plan);
        this.publishNext();

        Logger.info("MOTION PLANNER", {
            "Plan ID": plan.id,
            "Motions": `[${plan.motions.map((m) => this.formatMotion(m)).join(", ")}]`,
            "Priority": String(plan.priority),
            "Queue length": String(this.queue.length),
            "Timestamp": new Date(plan.timestamp).toISOString()
        });
    }

    processFromEvent(event: BehaviourEvent): void {
        const plan = this.buildDefaultPlan(event);
        if (!plan) {
            return;
        }

        this.queue.cancel(CancelRule.SAME_TYPE, event.action);
        this.queue.enqueue(plan);
        this.publishNext();

        Logger.info("MOTION PLANNER", {
            "Plan ID": plan.id,
            "Motions": `[${plan.motions.map((m) => this.formatMotion(m)).join(", ")}]`,
            "Priority": String(plan.priority),
            "Queue length": String(this.queue.length),
            "Timestamp": new Date(plan.timestamp).toISOString()
        });
    }

    /**
     * Progressive Intervention — Phase 1 motion. Emits a low-priority, silent
     * THINKING expression with no text bubble so the companion acknowledges the
     * error without firing an intrusive popup. The developer keeps editing space
     * to fix it first; proactive guidance arrives later via `processFromExplanation`.
     */
    processSilentThinking(): void {
        const now = Date.now();
        const plan: MotionPlan = {
            id: `mplan-silent-${now}-${Math.random().toString(36).slice(2, 8)}`,
            motions: [
                this.createMotion(`mot-${now}-0`, MotionType.CHANGE_EXPRESSION, { expression: "thinking" }, now, DEFAULT_EXPRESSION_DURATION, 2)
            ],
            sourceExplanation: undefined,
            timestamp: now,
            isInterruptible: true,
            priority: 2
        };

        this.queue.cancel(CancelRule.SAME_TYPE, 'silent-thinking');
        this.queue.enqueue(plan);
        this.publishNext();

        Logger.info("MOTION PLANNER", {
            "Plan ID": plan.id,
            "Motions": `[${plan.motions.map((m) => this.formatMotion(m)).join(", ")}]`,
            "Event": "Phase 1 — silent THINKING (no popup)",
            "Priority": String(plan.priority)
        });
    }

    publishNext(): void {
        const next = this.queue.dequeue();
        if (!next) {return;}

        this.publisher.publish(next);

        Logger.info("MOTION PLANNER", {
            "Plan ID": next.id,
            "Event": "Published from queue",
            "Priority": String(next.priority),
            "Remaining": String(this.queue.length)
        });
    }

    calculateEditorAnchor(editor: vscode.TextEditor, lineNum: number): WindowAnchorPayload {
        const visibleRanges = editor.visibleRanges;
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const lineHeight = editorConfig.get<number>('lineHeight') || 20;
        const fontSize = editorConfig.get<number>('fontSize') || 14;
        const charWidth = fontSize * 0.6;

        const selection = editor.selection;
        const cursorLine = selection.active.line;
        const cursorColumn = selection.active.character;

        let relativeLine = 0;
        if (visibleRanges.length > 0) {
            const firstVisible = visibleRanges[0].start.line;
            const lastVisible = visibleRanges[0].end.line;
            if (cursorLine >= firstVisible && cursorLine <= lastVisible) {
                relativeLine = cursorLine - firstVisible;
            } else {
                relativeLine = lastVisible - firstVisible;
            }
        }

        const editorLeft = 50;
        const editorTop = 30;
        const cursorX = editorLeft + cursorColumn * charWidth;
        const cursorY = editorTop + relativeLine * lineHeight + lineHeight / 2;

        const companionWidth = 360;
        const companionHeight = 180;

        let targetX = cursorX + 40;
        let targetY = cursorY - 30;

        targetX = Math.max(0, Math.min(targetX, 3840 - companionWidth));
        targetY = Math.max(0, Math.min(targetY, 2160 - companionHeight));

        return {
            type: 'WINDOW_ANCHOR',
            targetX,
            targetY,
            alignment: 'right-editor',
        };
    }

    calculateTerminalAnchor(): WindowAnchorPayload {
        const companionWidth = 360;
        const companionHeight = 180;

        let targetX = 100;
        let targetY = 600;

        targetX = Math.max(0, Math.min(targetX, 3840 - companionWidth));
        targetY = Math.max(0, Math.min(targetY, 2160 - companionHeight));

        return {
            type: 'WINDOW_ANCHOR',
            targetX,
            targetY,
            alignment: 'bottom-panel',
        };
    }

    getPublisher(): MotionPublisher {
        return this.publisher;
    }

    private buildPlan(explanation: Explanation): MotionPlan | undefined {
        const now = Date.now();
        const priority = this.resolvePriority(explanation.type);

        if (priority === 0) {
            return undefined;
        }

        const text = explanation.shortText || "";
        const motions: Motion[] = [];
        let idCounter = 0;

        const nextId = (): string => `mot-${now}-${idCounter++}`;

        switch (explanation.type) {

            case ExplanationType.WHY_ERROR_HELP: {
                const expression = this.resolveExplanationExpression(explanation.expression);
                motions.push(this.createMotion(nextId(), MotionType.SHOW_TEXT_BUBBLE, { text }, now, DEFAULT_TEXT_BUBBLE_DURATION, priority));
                motions.push(this.createMotion(nextId(), MotionType.CHANGE_EXPRESSION, { expression }, now, DEFAULT_EXPRESSION_DURATION, priority));
                break;
            }

            case ExplanationType.WHY_SUGGESTION: {
                motions.push(this.createMotion(nextId(), MotionType.NOD, {}, now, DEFAULT_NOD_DURATION, priority));
                motions.push(this.createMotion(nextId(), MotionType.SHOW_TEXT_BUBBLE, { text }, now, DEFAULT_TEXT_BUBBLE_DURATION, priority));
                break;
            }

            case ExplanationType.WHY_DEBUGGING: {
                motions.push(this.createMotion(nextId(), MotionType.POINT, { target: "editor" }, now, DEFAULT_POINT_DURATION, priority));
                motions.push(this.createMotion(nextId(), MotionType.SHOW_TEXT_BUBBLE, { text }, now, DEFAULT_TEXT_BUBBLE_DURATION, priority));
                break;
            }

            case ExplanationType.WHY_GIT_ACTION: {
                motions.push(this.createMotion(nextId(), MotionType.NOD, {}, now, DEFAULT_NOD_DURATION, priority));
                motions.push(this.createMotion(nextId(), MotionType.SHOW_TEXT_BUBBLE, { text }, now, DEFAULT_TEXT_BUBBLE_DURATION, priority));
                break;
            }

            case ExplanationType.WHY_EXTENSION: {
                motions.push(this.createMotion(nextId(), MotionType.NOD, {}, now, DEFAULT_NOD_DURATION, priority));
                motions.push(this.createMotion(nextId(), MotionType.SHOW_TEXT_BUBBLE, { text }, now, DEFAULT_TEXT_BUBBLE_DURATION, priority));
                break;
            }

            case ExplanationType.WHY_CELEBRATE: {
                motions.push(this.createMotion(nextId(), MotionType.NOD, {}, now, DEFAULT_NOD_DURATION, priority));
                motions.push(this.createMotion(nextId(), MotionType.CHANGE_EXPRESSION, { expression: "happy" }, now, DEFAULT_EXPRESSION_DURATION, priority));
                motions.push(this.createMotion(nextId(), MotionType.RAISE_HAND, {}, now, DEFAULT_RAISE_HAND_DURATION, priority));
                break;
            }

            default: {
                return undefined;
            }
        }

        return {
            id: `mplan-${now}-${Math.random().toString(36).slice(2, 8)}`,
            motions,
            sourceExplanation: explanation,
            timestamp: now,
            isInterruptible: priority < 8,
            priority
        };
    }

    private buildDefaultPlan(event: BehaviourEvent): MotionPlan | undefined {
        const now = Date.now();
        const priority = this.resolveActionPriority(event.action);

        if (priority === 0) {
            return undefined;
        }

        const text = `Aether is responding: ${event.action}`;
        let idCounter = 0;
        const nextId = (): string => `mot-${now}-${idCounter++}`;

        const motions: Motion[] = [
            this.createMotion(nextId(), MotionType.SHOW_TEXT_BUBBLE, { text }, now, DEFAULT_TEXT_BUBBLE_DURATION, priority)
        ];

        const expression = this.resolveExpression(event.action);
        if (expression) {
            motions.push(
                this.createMotion(nextId(), MotionType.CHANGE_EXPRESSION, { expression }, now, DEFAULT_EXPRESSION_DURATION, priority)
            );
        }

        return {
            id: `mplan-${now}-${Math.random().toString(36).slice(2, 8)}`,
            motions,
            timestamp: now,
            isInterruptible: true,
            priority
        };
    }

    private resolveExpression(action: BehaviourAction): string | undefined {
        switch (action) {
            case BehaviourAction.SHOW_ERROR_HELP:
                return "confused";
            case BehaviourAction.SHOW_DEBUG_HELP:
                return "thinking";
            case BehaviourAction.SHOW_WARNING:
                return "worried";
            case BehaviourAction.CELEBRATE:
                return "happy";
            default:
                return undefined;
        }
    }

    private resolveExplanationExpression(expression?: ExpressionType): string {
        switch (expression) {
            case "HAPPY":
                return "happy";
            case "THINKING":
                return "thinking";
            case "CONFUSED":
                return "confused";
            case "ALERT":
                return "worried";
            case "HELPFUL":
                return "neutral";
            case "IDLE":
                return "idle";
            default:
                return "confused";
        }
    }

    private createMotion(
        id: string,
        type: MotionType,
        params: Record<string, unknown>,
        startTime: number,
        duration: number,
        priority: number
    ): Motion {
        return { id, type, parameters: params, startTime, duration, priority };
    }

    private resolvePriority(type: ExplanationType): number {
        switch (type) {
            case ExplanationType.WHY_ERROR_HELP:
                return 10;
            case ExplanationType.WHY_DEBUGGING:
                return 8;
            case ExplanationType.WHY_GIT_ACTION:
                return 6;
            case ExplanationType.WHY_SUGGESTION:
                return 5;
            case ExplanationType.WHY_EXTENSION:
                return 5;
            case ExplanationType.WHY_CELEBRATE:
                return 3;
            default:
                return 0;
        }
    }

    private resolveActionPriority(action: BehaviourAction): number {
        switch (action) {
            case BehaviourAction.SHOW_ERROR_HELP:
                return 10;
            case BehaviourAction.SHOW_DEBUG_HELP:
                return 8;
            case BehaviourAction.ASK_USER:
                return 7;
            case BehaviourAction.SHOW_GIT_HELP:
                return 6;
            case BehaviourAction.SHOW_HINT:
            case BehaviourAction.SHOW_WARNING:
            case BehaviourAction.SHOW_DOCUMENTATION:
                return 5;
            case BehaviourAction.SHOW_EXTENSION_HELP:
                return 5;
            case BehaviourAction.CELEBRATE:
                return 3;
            default:
                return 0;
        }
    }

    private formatMotion(motion: Motion): string {
        if (motion.type === MotionType.CHANGE_EXPRESSION) {
            const expr = String(motion.parameters["expression"] || "neutral");
            return `CHANGE_EXPRESSION(${expr})`;
        }
        return motion.type;
    }
}

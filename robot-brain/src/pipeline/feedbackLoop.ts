import type { CognitivePipeline } from "./pipeline";
import type { BehaviourEvent } from "../behaviour/behaviourPublisher";
import type { ExecutionResult } from "../motionController/executionTypes";
import { Logger } from "../utils/logger";

const FEEDBACK_LOG_PREFIX = "FEEDBACK";
const MAX_FEEDBACK_HISTORY = 50;

interface FeedbackEntry {
    timestamp: number;
    action: string;
    pipelineStage: string;
    success: boolean;
    detail: string;
}

export class FeedbackLoop {
    private pipeline: CognitivePipeline;
    private history: FeedbackEntry[] = [];
    private behaviourListener?: (event: BehaviourEvent) => void;
    private motionListener?: (result: ExecutionResult) => void;

    constructor(pipeline: CognitivePipeline) {
        this.pipeline = pipeline;
    }

    start(): void {
        this.behaviourListener = (event: BehaviourEvent) => {
            this.recordFeedback("behaviour", event.action, true, "");
        };
        this.pipeline.getBehaviour().getPublisher().subscribe(this.behaviourListener);

        this.motionListener = (result: ExecutionResult) => {
            this.recordFeedback("motion", result.motionId, result.status === "COMPLETED", result.error || "");
        };
        this.pipeline.getMotionController().getPublisher().subscribe(this.motionListener);

        Logger.info(FEEDBACK_LOG_PREFIX, { Event: "Feedback loop started" });
    }

    dispose(): void {
        if (this.behaviourListener) {
            this.pipeline.getBehaviour().getPublisher().unsubscribe(this.behaviourListener);
            this.behaviourListener = undefined;
        }
        if (this.motionListener) {
            this.pipeline.getMotionController().getPublisher().unsubscribe(this.motionListener);
            this.motionListener = undefined;
        }
        Logger.info(FEEDBACK_LOG_PREFIX, { Event: "Feedback loop disposed" });
    }

    private recordFeedback(stage: string, action: string, success: boolean, detail: string): void {
        const entry: FeedbackEntry = {
            timestamp: Date.now(),
            action,
            pipelineStage: stage,
            success,
            detail
        };

        this.history.push(entry);
        if (this.history.length > MAX_FEEDBACK_HISTORY) {
            this.history.shift();
        }

        Logger.info(FEEDBACK_LOG_PREFIX, {
            Stage: stage,
            Action: action,
            Success: success ? "yes" : "no",
            Detail: detail || "none"
        });
    }

    getHistory(): readonly FeedbackEntry[] {
        return this.history;
    }

    getSuccessRate(): number {
        if (this.history.length === 0) {return 1;}
        const successes = this.history.filter(e => e.success).length;
        return successes / this.history.length;
    }
}

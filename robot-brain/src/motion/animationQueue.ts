import { MotionPlan } from "./motionPlan";
import { BehaviourAction } from "../behaviour/behaviourAction";

export enum CancelRule {
    LOWER_PRIORITY = "LOWER_PRIORITY",
    ALL = "ALL",
    KEEP_HIGHEST = "KEEP_HIGHEST",
    SAME_TYPE = "SAME_TYPE"
}

const MAX_QUEUE_SIZE = 20;
const AGING_THRESHOLD_MS = 30000;
const AGING_BOOST = 1;

export class AnimationQueue {
    private queue: MotionPlan[] = [];

    enqueue(plan: MotionPlan): void {
        this.agePlans();
        this.queue.push(plan);
        this.queue.sort((a, b) => b.priority - a.priority);
        if (this.queue.length > MAX_QUEUE_SIZE) {
            this.evictLowestPriority();
        }
    }

    dequeue(): MotionPlan | undefined {
        return this.queue.shift();
    }

    peek(): MotionPlan | undefined {
        return this.queue[0];
    }

    cancel(rule: CancelRule, threshold?: number | string | BehaviourAction): MotionPlan[] {
        const cancelled: MotionPlan[] = [];

        switch (rule) {
            case CancelRule.LOWER_PRIORITY: {
                const keep: MotionPlan[] = [];
                for (const p of this.queue) {
                    if (threshold !== undefined && p.priority < (threshold as number)) {
                        cancelled.push(p);
                    } else {
                        keep.push(p);
                    }
                }
                this.queue = keep;
                break;
            }
            case CancelRule.ALL: {
                cancelled.push(...this.queue);
                this.queue = [];
                break;
            }
            case CancelRule.KEEP_HIGHEST: {
                if (this.queue.length > 1) {
                    cancelled.push(...this.queue.slice(1));
                    this.queue = [this.queue[0]];
                }
                break;
            }
            case CancelRule.SAME_TYPE: {
                if (threshold === undefined) {break;}
                const thresholdStr = String(threshold);
                const keep: MotionPlan[] = [];
                for (const p of this.queue) {
                    const planType = this.resolvePlanType(p);
                    if (planType === thresholdStr) {
                        cancelled.push(p);
                    } else {
                        keep.push(p);
                    }
                }
                this.queue = keep;
                break;
            }
        }

        return cancelled;
    }

    clear(): void {
        this.queue = [];
    }

    get length(): number {
        return this.queue.length;
    }

    get entries(): MotionPlan[] {
        return [...this.queue];
    }

    private resolvePlanType(plan: MotionPlan): string {
        if (plan.sourceExplanation?.action) {
            return String(plan.sourceExplanation.action);
        }
        if (plan.sourceExplanation?.type) {
            return String(plan.sourceExplanation.type);
        }
        return plan.id;
    }

    private agePlans(): void {
        const now = Date.now();
        for (const p of this.queue) {
            if (now - p.timestamp > AGING_THRESHOLD_MS) {
                p.priority += AGING_BOOST;
            }
        }
        this.queue.sort((a, b) => b.priority - a.priority);
    }

    private evictLowestPriority(): void {
        if (this.queue.length <= MAX_QUEUE_SIZE) {return;}
        const toRemove = this.queue.length - MAX_QUEUE_SIZE;
        this.queue.splice(this.queue.length - toRemove, toRemove);
    }
}

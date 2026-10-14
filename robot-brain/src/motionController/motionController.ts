import * as vscode from "vscode";
import type { MotionPlan } from "../motion/motionPlan";
import { MotionType } from "../motion/motionTypes";
import { ExecutionStatus, ExecutionResult } from "./executionTypes";
import { MotionExecutor } from "./motionExecutor";
import { ControllerPublisher } from "./controllerPublisher";
import { Logger } from "../utils/logger";

const MOTION_COOLDOWN_MS = 2000;

export class MotionController {
    private executor: MotionExecutor;
    private publisher: ControllerPublisher;
    private currentPlan: MotionPlan | undefined;
    private currentPlanStartTime: number = 0;
    private isExecuting: boolean = false;
    private motionCooldowns: Map<string, number> = new Map();
    private abortController: AbortController | undefined;

    constructor() {
        this.executor = new MotionExecutor();
        this.publisher = new ControllerPublisher();
    }

    async executePlan(plan: MotionPlan): Promise<void> {
        if (this.isExecuting && this.currentPlan) {
            if (plan.priority < 10 && this.currentPlan.priority >= 10) {
                Logger.info("MOTION CONTROLLER", {
                    "Plan ID": plan.id,
                    "Status": "SKIPPED",
                    "Reason": "Higher priority plan running"
                });
                return;
            }

            if (plan.priority > this.currentPlan.priority) {
                this.interruptCurrentPlan(plan.id);
            }
        }

        this.isExecuting = true;
        this.currentPlan = plan;
        this.currentPlanStartTime = Date.now();
        this.abortController = new AbortController();

        const motionTypes: string[] = [];
        const results: ExecutionResult[] = [];

        try {
            for (const motion of plan.motions) {
                if (this.abortController.signal.aborted) {
                    results.push({
                        motionId: motion.id,
                        status: ExecutionStatus.INTERRUPTED,
                        startTime: Date.now()
                    });
                    continue;
                }

                if (this.isOnCooldown(motion.type)) {
                    results.push({
                        motionId: motion.id,
                        status: ExecutionStatus.SKIPPED,
                        startTime: Date.now(),
                        endTime: Date.now(),
                        error: "Motion on cooldown"
                    });
                    continue;
                }

                motionTypes.push(motion.type);

                const result = await this.executor.execute(motion);

                this.setCooldown(motion.type);
                results.push(result);
                this.publisher.publish(result);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.info("MOTION CONTROLLER", {
                "Plan ID": plan.id,
                "Status": "ERROR",
                "Reason": message
            });
        } finally {
            const totalDuration = Date.now() - this.currentPlanStartTime;

            this.isExecuting = false;
            this.currentPlan = undefined;
            this.abortController = undefined;

            const allCompleted = results.every(
                (r) => r.status === ExecutionStatus.COMPLETED || r.status === ExecutionStatus.SKIPPED
            );

            Logger.info("MOTION CONTROLLER", {
                "Plan ID": plan.id,
                "Executing": `[${motionTypes.join(", ")}]`,
                "Status": allCompleted ? "COMPLETED" : "PARTIAL",
                "Duration": `${totalDuration}ms`
            });
        }
    }

    getPublisher(): ControllerPublisher {
        return this.publisher;
    }

    private interruptCurrentPlan(newPlanId: string): void {
        if (this.abortController) {
            this.abortController.abort();
        }

        Logger.info("MOTION CONTROLLER", {
            "Plan ID": this.currentPlan?.id || "unknown",
            "Status": "INTERRUPTED",
            "Interrupted by": newPlanId
        });
    }

    private isOnCooldown(type: MotionType): boolean {
        if (type === MotionType.NONE || type === MotionType.SHOW_TEXT_BUBBLE) {
            return false;
        }

        this.evictExpiredMotionCooldowns();

        const lastTime = this.motionCooldowns.get(type);
        if (lastTime === undefined) {
            return false;
        }

        return Date.now() - lastTime < MOTION_COOLDOWN_MS;
    }

    private setCooldown(type: MotionType): void {
        if (type === MotionType.NONE) {
            return;
        }
        this.motionCooldowns.set(type, Date.now());
    }

    private evictExpiredMotionCooldowns(): void {
        const now = Date.now();
        for (const [key, time] of this.motionCooldowns) {
            if (now - time >= MOTION_COOLDOWN_MS) {
                this.motionCooldowns.delete(key);
            }
        }
    }
}

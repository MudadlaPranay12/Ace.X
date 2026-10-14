import { MotionType, Motion } from "../motion/motionTypes";
import { ExecutionStatus, ExecutionResult } from "./executionTypes";
import { sendToRobot } from "../utils/websocketServer";

export class MotionExecutor {
    async execute(motion: Motion): Promise<ExecutionResult> {
        const startTime = Date.now();

        try {
            let animation: string | undefined;
            let speech: string | undefined;

            switch (motion.type) {

                case MotionType.SHOW_TEXT_BUBBLE: {
                    speech = String(motion.parameters["text"] || "");
                    break;
                }

                case MotionType.SPEAK: {
                    // Voice disabled — operates as visual/text-only companion
                    break;
                }

                case MotionType.CHANGE_EXPRESSION: {
                    animation = String(motion.parameters["expression"] || "neutral");
                    break;
                }

                case MotionType.NOD: {
                    animation = "happy";
                    break;
                }

                case MotionType.SHAKE_HEAD: {
                    animation = "confused";
                    break;
                }

                case MotionType.RAISE_HAND: {
                    animation = "happy";
                    break;
                }

                case MotionType.POINT: {
                    animation = "thinking";
                    break;
                }

                case MotionType.GESTURE: {
                    animation = "happy";
                    break;
                }

                case MotionType.NONE: {
                    break;
                }

                default: {
                    break;
                }
            }

            if (animation || speech) {
                sendToRobot({ type: "ACTION", animation, speech });
            }

            const endTime = Date.now();
            return {
                motionId: motion.id,
                status: ExecutionStatus.COMPLETED,
                startTime,
                endTime
            };

        } catch (error) {
            const endTime = Date.now();
            return {
                motionId: motion.id,
                status: ExecutionStatus.FAILED,
                startTime,
                endTime,
                error: String(error)
            };
        }
    }
}
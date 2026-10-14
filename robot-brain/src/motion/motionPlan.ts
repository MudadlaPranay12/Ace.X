import type { Explanation } from "../explanation/explanationTypes";
import { Motion } from "./motionTypes";

export interface MotionPlan {
    id: string;
    motions: Motion[];
    sourceExplanation?: Explanation;
    timestamp: number;
    isInterruptible: boolean;
    priority: number;
}

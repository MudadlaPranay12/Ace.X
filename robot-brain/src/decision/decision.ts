import { DecisionType } from "./decisionType";
import type { Context } from "../context/context";

export interface Decision {
    id: string;
    type: DecisionType;
    confidence: number;
    timestamp: number;
    reason: string;
    sourceContext: Context;
    data: Record<string, unknown>;
}

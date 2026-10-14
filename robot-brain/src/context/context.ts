import { ContextType } from "./contextType";
import type { Observation } from "../perception/observation";

export interface Context {
    id: string;
    type: ContextType;
    confidence: number;
    timestamp: number;
    sourceObservation: Observation;
    data: Record<string, unknown>;
}

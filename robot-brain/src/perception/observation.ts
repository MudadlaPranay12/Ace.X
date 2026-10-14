import { ObservationType } from "./observationType";

export interface Observation {
    id: string;
    type: ObservationType;
    timestamp: number;
    confidence: number;
    /**
     * Optional 0..1 signal strength for observations where intensity matters
     * (e.g. how severe an error is, how long the user has been stuck). Absent
     * means "not meaningful for this observation type" — callers must not treat
     * an absent strength as 0.
     */
    strength?: number;
    source: string;
    data: Record<string, unknown>;
}

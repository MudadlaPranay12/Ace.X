export enum MotionType {
    NOD = "NOD",
    SHAKE_HEAD = "SHAKE_HEAD",
    RAISE_HAND = "RAISE_HAND",
    POINT = "POINT",
    SHOW_TEXT_BUBBLE = "SHOW_TEXT_BUBBLE",
    SPEAK = "SPEAK",
    CHANGE_EXPRESSION = "CHANGE_EXPRESSION",
    GESTURE = "GESTURE",
    NONE = "NONE"
}

export interface Motion {
    id: string;
    type: MotionType;
    parameters: Record<string, unknown>;
    startTime: number;
    duration: number;
    priority: number;
}

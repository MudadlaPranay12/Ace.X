import * as vscode from 'vscode';

export class Logger {
    private static outputChannel: vscode.OutputChannel | undefined;

    static initialize(channel?: vscode.OutputChannel): void {
        Logger.outputChannel = channel ?? vscode.window.createOutputChannel("Aether");
        Logger.outputChannel.show(true);
    }

    static setChannel(channel: vscode.OutputChannel): void {
        Logger.outputChannel = channel;
    }

    private static appendLine(message: string): void {
        if (Logger.outputChannel) {
            Logger.outputChannel.appendLine(message);
        } else {
            console.log(message);
        }
    }

    static info(sensorName: string, data: Record<string, string | number | undefined>): void {
        const lines: string[] = [
            "------------------------------------------------",
            "",
            `[${sensorName}]`,
            ""
        ];

        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null && value !== "") {
                lines.push(`${key} : ${value}`);
            }
        }

        lines.push("");
        lines.push("------------------------------------------------");

        Logger.appendLine(lines.join("\n"));
    }

    static pipelineTrace(steps: {
        sensor?: string;
        filter?: string;
        perceive?: string;
        context?: string;
        contextConfidence?: string;
        decision?: string;
        learner?: string;
        learnerScore?: string;
        actuator?: string;
        actuatorTarget?: string;
        express?: string;
        expressSpeech?: string;
    }): void {
        const pad = (s: string | undefined, w: number): string => {
            const v = s ?? '';
            return v.length > w ? v.slice(0, w - 1) + '…' : v.padEnd(w);
        };

        const out = [
            '┌────────────────────────────────────────────────────────────┐',
            '│                  PIPELINE TELEMETRY TRACE                  │',
            '├────────────────────────────────────────────────────────────┤',
            `│  [1. SENSOR]      Event captured: ${pad(steps.sensor, 35)}│`,
            `│  [2. FILTER]      Debounce status: ${pad(steps.filter, 34)}│`,
            `│  [3. PERCEIVE]    Observation: ${pad(steps.perceive, 36)}│`,
            `│  [4. CONTEXT]     Active Context: ${pad(steps.context, 24)} (Conf: ${pad(steps.contextConfidence, 4)}%)│`,
            `│  [5. DECISION]    Action Chosen: ${pad(steps.decision, 33)}│`,
            `│  [6. LEARNER]     Profile: ${pad(steps.learner, 23)} | Skill Score: ${pad(steps.learnerScore, 13)}│`,
            `│  [7. ACTUATOR]    Motion: ${pad(steps.actuator, 31)} ${pad(steps.actuatorTarget ?? '', 11)}│`,
            `│  [8. EXPRESS]     Face: ${pad(steps.express, 21)} | Speech: ${pad(steps.expressSpeech, 23)}│`,
            '└────────────────────────────────────────────────────────────┘',
        ];

        Logger.appendLine(out.join('\n'));
    }
}

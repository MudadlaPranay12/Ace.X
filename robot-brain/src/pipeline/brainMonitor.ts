import * as vscode from "vscode";
import type { CognitivePipeline } from "./pipeline";

const MONITOR_INTERVAL_MS = 30000;

export class BrainMonitor {
    private channel: vscode.OutputChannel;
    private pipeline: CognitivePipeline;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(channel: vscode.OutputChannel, pipeline: CognitivePipeline) {
        this.channel = channel;
        this.pipeline = pipeline;
    }

    start(): void {
        this.timer = setInterval(() => this.report(), MONITOR_INTERVAL_MS);
        this.report();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private report(): void {
        const stats = this.pipeline.getStats();
        const uptimeSec = Math.floor(stats.uptime / 1000);
        const uptimeMin = Math.floor(uptimeSec / 60);
        const uptimeHr = Math.floor(uptimeMin / 60);

        const ws = this.pipeline.getPerception().getWorkspaceState();

        this.channel.appendLine("");
        this.channel.appendLine("═══════════════════════════════════════════════════");
        this.channel.appendLine(`  AETHER BRAIN — ${new Date().toLocaleTimeString()}`);
        this.channel.appendLine("═══════════════════════════════════════════════════");
        this.channel.appendLine(`  Uptime: ${uptimeHr}h ${uptimeMin % 60}m ${uptimeSec % 60}s`);
        this.channel.appendLine(`  Events processed: ${stats.eventsProcessed}`);
        this.channel.appendLine("");
        this.channel.appendLine("  PERCEPTION");
        this.channel.appendLine(`    Current file: ${ws.currentFile || "(none)"}`);
        this.channel.appendLine(`    Language: ${ws.currentLanguage || "(none)"}`);
        this.channel.appendLine(`    Diagnostics: ${ws.diagnosticCount}`);
        this.channel.appendLine(`    Cursor: line ${ws.currentCursorLine}, col ${ws.currentCursorColumn}`);
        this.channel.appendLine("═══════════════════════════════════════════════════");
        this.channel.appendLine("");
    }
}

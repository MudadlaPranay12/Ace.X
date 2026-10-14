import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { Logger } from './utils/logger';

interface ProcessManagerOptions {
    extensionUri: vscode.Uri;
    wsPort: number;
    relaunchDelayMs?: number;
    maxRelaunchAttempts?: number;
}

/**
 * Owns the lifetime of the Robot Body (the floating Eve companion window).
 *
 * Launch resolution, in order:
 *   1. Packaged companion shipped INSIDE the installed extension
 *      (<extension>/companion/win-x64/BotX Companion.exe). This is the
 *      production path and depends on nothing outside the extension folder.
 *   2. Development fallback: the `electron` binary from the repository's
 *      node_modules running the robot-body source folder. Only used when the
 *      packaged companion is absent (F5 / Extension Development Host).
 *
 * Nothing here depends on a workspace folder being open, and no absolute
 * development path is ever hardcoded — everything is derived from
 * context.extensionUri or from Node module resolution.
 */
export class ProcessManager {
    private robotProcess: ChildProcess | null = null;
    private readonly extensionUri: vscode.Uri;
    private readonly wsPort: number;
    private readonly relaunchDelayMs: number;
    private readonly maxRelaunchAttempts: number;
    private relaunchAttempts = 0;
    private relaunchTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;
    private lastLaunchMode: 'packaged' | 'development' | null = null;

    /**
     * Set while a kill was requested on purpose (restart, dispose, window
     * deactivation), cleared when the child actually exits.
     *
     * This exists because Windows does not report a killed child the way POSIX
     * does: `child.kill('SIGTERM')` on win32 terminates the process
     * unconditionally, so the exit event can arrive with `code === 1` and
     * `signal === null`. The crash guard in the exit handler therefore cannot
     * distinguish "the user closed the companion" from "we just killed it during
     * a restart", and a restart would end up racing two launches — the 800ms
     * restart timer and a crash-relaunch timer created by the same exit.
     *
     * An explicit flag is unambiguous, and it also covers the spawn-error path
     * where the child never existed at all.
     */
    private intentionalKill = false;

    constructor(options: ProcessManagerOptions) {
        this.extensionUri = options.extensionUri;
        this.wsPort = options.wsPort;
        this.relaunchDelayMs = options.relaunchDelayMs ?? 2000;
        this.maxRelaunchAttempts = options.maxRelaunchAttempts ?? 5;

        process.on('exit', () => this.killProcess());
    }

    launchRobotBody(): void {
        if (this.disposed) {
            Logger.info('PROCESS_MANAGER', { Event: 'Cannot launch, manager disposed' });
            return;
        }

        if (this.robotProcess && !this.robotProcess.killed) {
            Logger.info('PROCESS_MANAGER', { Event: 'robot-body already running' });
            return;
        }

        const launch = this.resolveLaunchTarget();
        if (!launch) {
            Logger.info('PROCESS_MANAGER', {
                Event: 'Robot Body not found',
                Searched: this.extensionUri.fsPath,
                Hint: 'Run "npm run package:body" to build the packaged companion, or install dependencies for the development fallback'
            });
            return;
        }

        this.lastLaunchMode = launch.mode;

        Logger.info('PROCESS_MANAGER', {
            Event: 'Launching robot-body',
            Mode: launch.mode,
            Executable: launch.executable,
            Args: launch.args.join(' ')
        });

        try {
            // The VS Code extension host runs electron with ELECTRON_RUN_AS_NODE=1.
            // Inheriting that would boot the robot-body electron.exe as plain Node
            // (no `app` object) and crash at main.js — so always strip it.
            const childEnv: NodeJS.ProcessEnv = {
                ...process.env,
                ROBOT_WS_PORT: String(this.wsPort)
            };
            delete childEnv.ELECTRON_RUN_AS_NODE;

            const child = spawn(launch.executable, launch.args, {
                cwd: launch.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false,
                env: childEnv
            });
            this.robotProcess = child;

            child.stdout?.on('data', (data: Buffer) => {
                const msg = data.toString().trim();
                if (msg) {
                    Logger.info('PROCESS_MANAGER', { Event: 'robot-body stdout', Output: msg });
                }
            });

            child.stderr?.on('data', (data: Buffer) => {
                const msg = data.toString().trim();
                if (msg) {
                    Logger.info('PROCESS_MANAGER', { Event: 'robot-body stderr', Output: msg });
                }
            });

            child.on('exit', (code, signal) => {
                // Ignore the exit of a child that is no longer the current one.
                // A restart can replace this.robotProcess before Windows gets
                // around to reporting the old child's termination; without this
                // guard the stale exit would null out the NEW child's reference
                // and schedule a duplicate relaunch.
                if (this.robotProcess !== child) {
                    return;
                }
                Logger.info('PROCESS_MANAGER', {
                    Event: 'robot-body exited',
                    Code: String(code ?? 'null'),
                    Signal: String(signal ?? 'null')
                });
                const intentional = this.intentionalKill;
                this.intentionalKill = false;
                this.robotProcess = null;

                // A manual window close quits the app with code 0 — that is a
                // deliberate user action, so it must NOT trigger a relaunch.
                // Only crashes and spawn errors come back on their own. The
                // intentionalKill flag additionally covers kills we issued.
                if (!this.disposed && !intentional && code !== 0 && signal !== 'SIGTERM') {
                    this.scheduleRelaunch();
                }
            });

            child.on('error', (err) => {
                if (this.robotProcess !== child) {
                    return;
                }
                Logger.info('PROCESS_MANAGER', { Event: 'robot-body spawn error', Error: String(err) });
                const intentional = this.intentionalKill;
                this.intentionalKill = false;
                this.robotProcess = null;

                if (!this.disposed && !intentional) {
                    this.scheduleRelaunch();
                }
            });

            this.relaunchAttempts = 0;
            Logger.info('PROCESS_MANAGER', { Event: 'robot-body launched successfully' });
        } catch (err) {
            Logger.info('PROCESS_MANAGER', { Event: 'Failed to spawn robot-body', Error: String(err) });
        }
    }

    /**
     * Stops the Robot Body and starts a fresh one. Used by "BotX: Restart
     * Companion". The relaunch timer is cleared first so the forced kill is not
     * mistaken for a crash.
     */
    restartRobotBody(): void {
        Logger.info('PROCESS_MANAGER', { Event: 'Restart requested' });

        if (this.relaunchTimer) {
            clearTimeout(this.relaunchTimer);
            this.relaunchTimer = null;
        }

        if (this.robotProcess) {
            this.killProcess();
        }

        // Fallback timer for the forced relaunch. The old child's exit handler
        // cannot also relaunch, because the kill set intentionalKill; and if the
        // old child outlives this timer, the child-scoped guard in its exit
        // handler discards that later exit. Exactly one relaunch results.
        this.relaunchTimer = setTimeout(() => {
            this.relaunchTimer = null;
            if (this.disposed) {
                return;
            }
            this.robotProcess = null;
            this.intentionalKill = false;
            this.launchRobotBody();
        }, 800);
    }

    isRunning(): boolean {
        return this.robotProcess !== null && !this.robotProcess.killed;
    }

    /** Which resolution path produced the current/most recent launch. */
    getLaunchMode(): 'packaged' | 'development' | null {
        return this.lastLaunchMode;
    }

    /**
     * Resolves how to start the Robot Body.
     *
     * Production: the packaged companion directory inside the extension.
     * Development: the `electron` package from the repository (resolved
     * relative to this file's location inside the monorepo) running the
     * robot-body source folder.
     */
    private resolveLaunchTarget():
        | { executable: string; args: string[]; cwd: string; mode: 'packaged' | 'development' }
        | null {
        const fs = require('fs');

        // ── 1. Packaged companion inside the installed extension ────────────
        const companionCandidates = [
            path.join(this.extensionUri.fsPath, 'companion', 'win-x64', 'BotX Companion.exe')
        ];
        for (const exe of companionCandidates) {
            if (fs.existsSync(exe)) {
                // No args: the packaged app knows its own asar contents.
                return { executable: exe, args: [], cwd: path.dirname(exe), mode: 'packaged' };
            }
        }

        // ── 2. Development fallback: electron + robot-body source ───────────
        // __dirname is <repo>/robot-brain/out at dev time, so the robot-body
        // source folder is always exactly two levels above.
        const robotBodyDir = path.resolve(__dirname, '..', '..', 'robot-body');
        if (fs.existsSync(path.join(robotBodyDir, 'main.js'))) {
            const electronBin = this.resolveElectronBinary(robotBodyDir);
            if (electronBin) {
                return { executable: electronBin, args: [robotBodyDir], cwd: robotBodyDir, mode: 'development' };
            }
        }

        return null;
    }

    /**
     * Resolves the Electron runtime used only by the development fallback.
     * `node main.js` can never work here because main.js requires the
     * 'electron' module, so an actual Electron binary is mandatory.
     */
    private resolveElectronBinary(robotBodyDir: string): string | null {
        const fs = require('fs');
        const exeName = process.platform === 'win32'
            ? 'electron.exe'
            : process.platform === 'darwin'
                ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
                : 'electron';

        const packageCandidates = [
            path.join(robotBodyDir, 'node_modules', 'electron'),
            path.join(robotBodyDir, '..', 'node_modules', 'electron'),
            path.join(robotBodyDir, '..', '..', 'node_modules', 'electron')
        ];

        for (const pkg of packageCandidates) {
            try {
                const direct = path.join(pkg, 'dist', exeName);
                if (fs.existsSync(direct)) {
                    return direct;
                }
                // electron npm package contract: dist/<contents of path.txt>
                const pathFile = path.join(pkg, 'path.txt');
                if (fs.existsSync(pathFile)) {
                    const target = path.join(pkg, 'dist', fs.readFileSync(pathFile, 'utf-8').trim());
                    if (fs.existsSync(target)) {
                        return target;
                    }
                }
            } catch {
                // try next candidate
            }
        }

        return null;
    }

    killProcess(): void {
        const child = this.robotProcess;
        if (child && !child.killed) {
            Logger.info('PROCESS_MANAGER', { Event: 'Killing robot-body process' });
            this.intentionalKill = true;
            try {
                child.kill('SIGTERM');
                // Escalate against the SAME child object. Holding the reference
                // means this can never reach a replacement process, even if a
                // restart has already spawned one.
                setTimeout(() => {
                    if (!child.killed) {
                        child.kill('SIGKILL');
                    }
                }, 3000);
            } catch (err) {
                Logger.info('PROCESS_MANAGER', { Event: 'Error killing process', Error: String(err) });
            }
        }
    }

    private scheduleRelaunch(): void {
        if (this.disposed) {
            return;
        }

        if (this.relaunchAttempts >= this.maxRelaunchAttempts) {
            Logger.info('PROCESS_MANAGER', {
                Event: 'Max relaunch attempts reached',
                Attempts: String(this.relaunchAttempts)
            });
            return;
        }

        this.relaunchAttempts++;

        Logger.info('PROCESS_MANAGER', {
            Event: 'Scheduling relaunch',
            Attempt: String(this.relaunchAttempts),
            DelayMs: String(this.relaunchDelayMs)
        });

        if (this.relaunchTimer) {
            clearTimeout(this.relaunchTimer);
        }

        this.relaunchTimer = setTimeout(() => {
            this.relaunchTimer = null;
            this.launchRobotBody();
        }, this.relaunchDelayMs);
    }

    dispose(): void {
        this.disposed = true;

        if (this.relaunchTimer) {
            clearTimeout(this.relaunchTimer);
            this.relaunchTimer = null;
        }

        this.killProcess();

        Logger.info('PROCESS_MANAGER', { Event: 'ProcessManager disposed' });
    }
}
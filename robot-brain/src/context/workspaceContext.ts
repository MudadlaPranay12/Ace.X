import { ContextType } from "./contextType";

export class WorkspaceContext {
    private _currentFile: string = "";
    private _currentLanguage: string = "";
    private _currentContext: ContextType = ContextType.IDLE;
    private _cursorLine: number = 0;
    private _cursorColumn: number = 0;
    private _terminalActive: boolean = false;
    private _debuggerActive: boolean = false;
    private _gitBranch: string = "";
    private _lastError: string = "";
    private _lastContextTime: number = 0;

    get currentFile(): string {
        return this._currentFile;
    }

    set currentFile(value: string) {
        this._currentFile = value;
    }

    get currentLanguage(): string {
        return this._currentLanguage;
    }

    set currentLanguage(value: string) {
        this._currentLanguage = value;
    }

    get currentContext(): ContextType {
        return this._currentContext;
    }

    set currentContext(value: ContextType) {
        this._currentContext = value;
    }

    get cursorLine(): number {
        return this._cursorLine;
    }

    set cursorLine(value: number) {
        this._cursorLine = value;
    }

    get cursorColumn(): number {
        return this._cursorColumn;
    }

    set cursorColumn(value: number) {
        this._cursorColumn = value;
    }

    get terminalActive(): boolean {
        return this._terminalActive;
    }

    set terminalActive(value: boolean) {
        this._terminalActive = value;
    }

    get debuggerActive(): boolean {
        return this._debuggerActive;
    }

    set debuggerActive(value: boolean) {
        this._debuggerActive = value;
    }

    get gitBranch(): string {
        return this._gitBranch;
    }

    set gitBranch(value: string) {
        this._gitBranch = value;
    }

    get lastError(): string {
        return this._lastError;
    }

    set lastError(value: string) {
        this._lastError = value;
    }

    get lastContextTime(): number {
        return this._lastContextTime;
    }

    set lastContextTime(value: number) {
        this._lastContextTime = value;
    }

    reset(): void {
        this._currentFile = "";
        this._currentLanguage = "";
        this._currentContext = ContextType.IDLE;
        this._cursorLine = 0;
        this._cursorColumn = 0;
        this._terminalActive = false;
        this._debuggerActive = false;
        this._gitBranch = "";
        this._lastError = "";
        this._lastContextTime = 0;
    }
}

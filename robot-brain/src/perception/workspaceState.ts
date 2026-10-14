export class WorkspaceState {
    private _currentFile: string = "";
    private _currentLanguage: string = "";
    private _currentCursorLine: number = 0;
    private _currentCursorColumn: number = 0;
    private _openedFiles: string[] = [];
    private _activeTerminal: string = "";
    private _gitBranch: string = "";
    private _diagnosticCount: number = 0;
    private _lastEventTime: number = 0;
    private _lastCrash: string = "";
    private _lastDebugBreak: string = "";
    private _lastCheckpoint: string = "";
    private _lastConflict: string = "";

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

    get currentCursorLine(): number {
        return this._currentCursorLine;
    }

    set currentCursorLine(value: number) {
        this._currentCursorLine = value;
    }

    get currentCursorColumn(): number {
        return this._currentCursorColumn;
    }

    set currentCursorColumn(value: number) {
        this._currentCursorColumn = value;
    }

    get openedFiles(): string[] {
        return [...this._openedFiles];
    }

    set openedFiles(value: string[]) {
        this._openedFiles = [...value];
    }

    addOpenedFile(file: string): void {
        if (!this._openedFiles.includes(file)) {
            this._openedFiles.push(file);
        }
    }

    removeOpenedFile(file: string): void {
        this._openedFiles = this._openedFiles.filter((f) => f !== file);
    }

    get activeTerminal(): string {
        return this._activeTerminal;
    }

    set activeTerminal(value: string) {
        this._activeTerminal = value;
    }

    get gitBranch(): string {
        return this._gitBranch;
    }

    set gitBranch(value: string) {
        this._gitBranch = value;
    }

    get diagnosticCount(): number {
        return this._diagnosticCount;
    }

    set diagnosticCount(value: number) {
        this._diagnosticCount = value;
    }

    get lastEventTime(): number {
        return this._lastEventTime;
    }

    set lastEventTime(value: number) {
        this._lastEventTime = value;
    }

    get lastCrash(): string {
        return this._lastCrash;
    }

    set lastCrash(value: string) {
        this._lastCrash = value;
    }

    get lastDebugBreak(): string {
        return this._lastDebugBreak;
    }

    set lastDebugBreak(value: string) {
        this._lastDebugBreak = value;
    }

    get lastCheckpoint(): string {
        return this._lastCheckpoint;
    }

    set lastCheckpoint(value: string) {
        this._lastCheckpoint = value;
    }

    get lastConflict(): string {
        return this._lastConflict;
    }

    set lastConflict(value: string) {
        this._lastConflict = value;
    }
}

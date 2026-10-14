export class Debounce {
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    debounce(key: string, callback: () => void, delay: number): void {
        const existing = this.timers.get(key);

        if (existing !== undefined) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.timers.delete(key);
            callback();
        }, delay);

        this.timers.set(key, timer);
    }

    clear(key?: string): void {
        if (key !== undefined) {
            const timer = this.timers.get(key);
            if (timer !== undefined) {
                clearTimeout(timer);
                this.timers.delete(key);
            }
            return;
        }

        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        this.timers.clear();
    }
}

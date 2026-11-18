type Listener<T> = (value: T) => void;

interface ListenerRecord<T> {
	readonly callback: Listener<T>;
	connected: boolean;
}

export class Signal<T> {
	private readonly listeners: ListenerRecord<T>[] = [];

	public connect(listener: Listener<T>): () => void {
		const record: ListenerRecord<T> = { callback: listener, connected: true };
		this.listeners.push(record);
		return () => (record.connected = false);
	}

	public fire(value: T): void {
		for (const listener of this.listeners) {
			if (listener.connected) listener.callback(value);
		}
	}
}

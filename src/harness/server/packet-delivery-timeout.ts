export function withPacketDeliveryTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			},
		);
	});
}

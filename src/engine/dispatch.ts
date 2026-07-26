// R-012 — L3 registration, discovery, and dispatch precedence (contracts §3,
// G11/F19/G1). Patterns are AsyncAPI channel addresses with {param} captures,
// resolved AT DISPATCH by the registry's own matcher — never an MQTT filter,
// never resolved at import time (a handler needs no specs loaded to register,
// and a spec hot-swap never leaves it bound to a stale channel set).
import type {
	Handler,
	HandlerFactory,
	SpecRegistry,
} from "#src/model/index.ts";

export interface Registration {
	pattern: string;
	factory: HandlerFactory;
	modulePath: string;
	order: number;
}

export interface DispatchRegistry {
	register(pattern: string, factory: HandlerFactory, modulePath?: string): void;
	loadHandlers(dir: string): Promise<string[]>;
	instantiate(): void;
	select(
		topic: string,
		registry: SpecRegistry,
	):
		| {
				handler: Handler;
				registration: Registration;
				params: Record<string, string>;
		  }
		| undefined;
	all(): { handler: Handler; registration: Registration }[];
}

// code-unit comparison, NOT localeCompare: precedence must be identical
// across machines/ICU builds and consistent with loadHandlers' path sort.
// Exported for direct unit testing (mutation-kill: engine sort internals
// hide tie-break defects behind stable-sort no-swaps).
export function precedence(a: Registration, b: Registration): number {
	if (a.modulePath < b.modulePath) return -1;
	if (a.modulePath > b.modulePath) return 1;
	return a.order - b.order;
}

export function createDispatchRegistry(): DispatchRegistry {
	const registrations: Registration[] = [];
	const instances = new Map<Registration, Handler>();
	let order = 0;
	let importingPath = ""; // set around each loadHandlers import; "" = direct registration

	return {
		register(pattern, factory, modulePath) {
			registrations.push({
				pattern,
				factory,
				modulePath: modulePath ?? importingPath,
				order: order++,
			});
		},

		async loadHandlers(dir) {
			const glob = new Bun.Glob("**/*.ts");
			const paths = (
				await Array.fromAsync(glob.scan({ cwd: dir, absolute: true }))
			).sort();
			for (const p of paths) {
				importingPath = p;
				try {
					await import(p);
				} finally {
					importingPath = "";
				}
			}
			return paths;
		},

		instantiate() {
			instances.clear();
			for (const r of registrations) instances.set(r, r.factory());
		},

		select(topic, registry) {
			const m = registry.match(topic);
			if (!m) return undefined;
			// the matcher already applied most-specific-beats-{param} in choosing
			// the channel; among registrations on that channel: sorted module path,
			// then registration order (G11)
			const candidates = registrations
				.filter((r) => r.pattern === m.channel.topic)
				.sort(precedence);
			const winner = candidates[0];
			// Stryker disable next-line ConditionalExpression: with no winner, instances.get(undefined) is undefined and the !handler guard below returns the same undefined
			if (!winner) return undefined;
			const handler = instances.get(winner);
			if (!handler) return undefined; // instantiate() not yet called
			return { handler, registration: winner, params: m.params };
		},

		all() {
			return [...registrations]
				.sort(precedence)
				.map((r) => ({ handler: instances.get(r), registration: r }))
				.filter((x): x is { handler: Handler; registration: Registration } =>
					Boolean(x.handler),
				);
		},
	};
}

// The process singleton behind the contracts §3 free function. User handler
// modules import { register } and call it at module top level (G11).
export const defaultDispatch: DispatchRegistry = createDispatchRegistry();

export function register(pattern: string, factory: HandlerFactory): void {
	defaultDispatch.register(pattern, factory);
}

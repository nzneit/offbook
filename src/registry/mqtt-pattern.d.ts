// `mqtt-pattern` ships no type declarations (plain JS, no @types package).
// Minimal ambient shim for the two exports registry/ uses.
declare module "mqtt-pattern" {
	export function matches(pattern: string, topic: string): boolean;
	export function exec(
		pattern: string,
		topic: string,
	): Record<string, string> | null;
}

// R-045/D-032 — guarded mutation, the ONE rule behind every record delete,
// foreign rewrite, and pid signal (design "Guarded mutation: one rule,
// five sites"): re-read the precondition IMMEDIATELY before acting; abort
// on mismatch. Sites: (1) pointer reap, (2) runfile reclaim / post-kill
// clear, (3) down's signal + SIGKILL re-verify, (4) the failed-boot clear,
// (5) the self-heal rewrite. Each site instantiates this helper so tests
// pin the rule per site.
export async function guarded<T>(site: {
	read: () => T | Promise<T>;
	expect: (current: T) => boolean;
	act: () => void | Promise<void>;
}): Promise<boolean> {
	const current = await site.read();
	if (!site.expect(current)) return false;
	await site.act();
	return true;
}

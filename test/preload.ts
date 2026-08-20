// Claim this process's test-port band BEFORE anything else loads: ./ports.ts
// binds a sentinel socket as an import side effect, and every port(...) call in
// the suite reads the band it settles on. Keep this the FIRST statement in the
// file — a module that binds at module scope must never load ahead of the
// claim. See .superpowers/sdd/port-namespacing-design.md.
import "./ports.ts";
// D-032 hermeticity net: pin OFFBOOK_STATE_DIR for the WHOLE suite before
// any test file loads, so nothing — in-process run() calls, spawned real
// servers (they inherit env; logSafeEnv preserves this var), doctor scans —
// can default into the real ~/.local/state. Test files that assert on scan
// CONTENTS still pin their own per-test dir (set + restore around run()).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OFFBOOK_STATE_DIR)
	process.env.OFFBOOK_STATE_DIR = mkdtempSync(
		join(tmpdir(), "offbook-suite-state-"),
	);

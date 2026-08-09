// R-042 — the CLI's invocation forms, one source of truth (adoption.md §9,
// review-round fork e): USAGE, the dispatch table, and check-docs' skill
// verb-existence gate all derive from this list. A LEAF module: imports
// nothing, so scripts/check-docs.ts can import it without dragging the CLI's
// transport stack into the doc gate. Argument VALUES are not forms
// (`mode autonomous` is `mode` + argument); subcommands are (`specs update`).
export const VERB_FORMS: readonly string[] = [
	"init",
	"doctor",
	"demo",
	"up",
	"down",
	"status",
	"logs",
	"topics",
	"state",
	"publish",
	"scenario",
	"scenarios",
	"reset",
	"mode",
	"validation",
	"check",
	"diagnostics",
	"specs",
	"specs update",
];

// first tokens that take a subcommand (any verb with a two-token form)
export const SUBCOMMAND_FIRST_TOKENS: ReadonlySet<string> = new Set(
	VERB_FORMS.filter((f) => f.includes(" ")).map((f) => f.split(" ")[0]),
);

"use strict";

// Dedicated CLI entry for tooling that cannot prepend the runner's cli mode.
process.argv.splice(2, 0, "cli");
require("./run.cjs");

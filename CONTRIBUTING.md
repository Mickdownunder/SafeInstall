# Contributing to SafeInstall

SafeInstall is a solo-maintained open-source project. Issues, bug reports, and pull requests are welcome. The maintainer reviews and merges at own discretion.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) (version managed via `packageManager` in `package.json`)

## Setup

```bash
git clone https://github.com/Mickdownunder/SafeInstall.git
cd SafeInstall
pnpm install
```

## Development workflow

```bash
pnpm typecheck          # TypeScript strict-mode check
pnpm test               # Run the full test suite (vitest)
pnpm build              # Compile to dist/
pnpm dev                # Build and run the CLI locally
```

All three gates — typecheck, test, build — must pass before submitting a pull request.

## Running the CLI locally

After building, you can run SafeInstall from the repo:

```bash
pnpm build
node dist/cli.js --version
node dist/cli.js pnpm add axios
```

## Commit format

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message should follow the pattern:

```
type(scope): short description

Optional longer body explaining the why.
```

Common types: `feat`, `fix`, `chore`, `docs`, `test`, `ci`, `refactor`.

Examples:
- `feat(policy): add typo-squat detection against top-package list`
- `fix(registry): handle TimeoutError from AbortSignal.timeout()`
- `docs(readme): update configuration reference for 0.2.0`
- `chore(deps): upgrade vitest to v4`

## Submitting a pull request

1. Fork the repository and create a branch from `main`.
2. Make your changes in focused, reviewable commits.
3. Run `pnpm typecheck && pnpm test && pnpm build` and confirm everything passes.
4. Open a pull request against `main` with a clear title and description.
5. Respond to review feedback promptly.

## What makes a good contribution

- **Bug fixes** with a regression test that fails before the fix and passes after.
- **Documentation improvements** that clarify behavior, fix typos, or add missing examples.
- **Test coverage** for edge cases that aren't covered yet.
- **Performance improvements** with before/after measurements.

## What to avoid

- Large refactors without prior discussion in an issue.
- New features without an issue or discussion first — open an issue to propose your idea before writing code.
- Changes that break backward compatibility without a clear rationale and a migration path.
- Adding dependencies unless strictly necessary. SafeInstall ships as a CLI tool and dependency count matters.

## Code style

- TypeScript strict mode, no `any` escapes.
- No comments unless the *why* is non-obvious.
- Prefer editing existing files over creating new ones.
- Keep test names descriptive enough that a failure message tells you what broke.

## Security issues

If you discover a security vulnerability, please report it privately via email to **Michael@acpip.io** instead of opening a public issue. Security reports will be acknowledged within 48 hours.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).

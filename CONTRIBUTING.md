# Contributing

See the development commands in [README.md](README.md).

The pre-commit hook (lefthook) runs `oxfmt --check`, `oxlint` and the typecheck on staged files.
Run `npm run format` and `npm run lint` before committing. Fix lint findings in the code rather
than relaxing `.oxlintrc.json`.

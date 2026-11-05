# Release process (tag → npm, maintainers only)

The guard lives in `.githooks/pre-push`; this page is the full recipe.

Version numbers in **three places** must agree (the hook rejects a tag that disagrees):

| Place | npm package |
|---|---|
| the git tag (`v0.2.0` and `0.2.0` both work) | triggers the publish |
| `packages/ext/package.json` → `version` | `piher` |
| root `package.json` → `version` | `piher-setup` |

```sh
# 1. set both package.json versions to the target version (must be greater than what npm has)
# 2. commit, tag with the same name, push:
git commit -am "release: 0.2.0"
git tag 0.2.0
git push && git push --tags   # GitHub Actions runs the tests and publishes through Trusted Publishing
```

Rules:

- Install the hook once per clone: `git config core.hooksPath .githooks` (`npm install` does it
  through the `prepare` script).
- Versions only go up: npm cannot republish a version, and a tag name cannot be reused.
- A tag deletion push (all-zero sha) is not checked — see `pre-push`.

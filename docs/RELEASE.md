# Release process (tag → npm, maintainers only)

The guard lives in `.githooks/pre-push`; this page is the full recipe.

Two version numbers must agree (the hook rejects a tag that disagrees):

| Place | npm package |
|---|---|
| the git tag (`v0.2.0` and `0.2.0` both work) | triggers the publish |
| `packages/ext/package.json` → `version` | `piher` |

The root `package.json` is a private workspace root and carries no version to publish.

```sh
# 1. set the version in packages/ext/package.json (must be greater than what npm has)
# 2. commit, tag with the same name, push:
git commit -am "release: 0.2.0"
git tag 0.2.0
git push && git push --tags   # GitHub Actions runs the tests, publishes through Trusted
                              # Publishing, and opens the GitHub Release for the tag
```

The Release is written by the `release` job in `publish.yml`, after the package is on npm, and uses
GitHub's generated notes: `.github/release.yml` defines the categories and
`.github/scripts/merge-release-notes.mjs` folds in the conventional-commit entries of commits that
have no pull request, so a direct push to `master` still lands under *Features*, *Fixes*,
*Security* or *Refactors* instead of *Other Changes*.

Rules:

- Install the hook once per clone: `git config core.hooksPath .githooks` (`npm install` does it
  through the `prepare` script).
- Versions only go up: npm cannot republish a version, and a tag name cannot be reused.
- A tag deletion push (all-zero sha) is not checked — see `pre-push`.
- `publish.yml` skips the package when npm already holds that version, so a tag pushed after a manual
  publish stays green instead of failing.

## One-time setup (a package that does not exist on npm yet)

Trusted Publishing is registered **per package on npmjs.com**, and npm only offers that page once the
package exists. A brand-new package therefore cannot be published by the workflow: the first version
goes out by hand, and the tag is pushed afterwards.

```sh
npm login                              # or `npm whoami` to check the token still works
cd packages/ext && npm publish         # piher@X.Y.Z — use --otp=<code> if the account has 2FA
git tag -f X.Y.Z && git push && git push --tags   # the workflow finds the version published
```

Use `--otp` with a code from the authenticator app rather than the browser prompt: a browser-auth
publish can land in npm's staged queue with no stage id (npm/cli#9889), and that version number is
then unusable forever.

Then, for `piher` on npmjs.com → *Settings → Trusted Publishing*:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization / user | `felixzsh` |
| Repository | `piher` |
| Workflow filename | `publish.yml` |
| Environment | *(empty)* |

That registration is what lets the workflow publish with an OIDC token instead of a stored secret
(`id-token: write`, npm ≥ 11.5 — `publish.yml` installs it). The `repository` field in
`packages/ext/package.json` must keep pointing at `github.com/felixzsh/piher`: npm matches it against
the repository that runs the workflow, and provenance is built from it.

Note: Trusted Publishing and provenance from a **private** repository need a paid npm plan; a public
repository needs nothing.

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
git push && git push --tags   # GitHub Actions runs the tests, publishes through Trusted
                              # Publishing, and opens the GitHub Release for the tag
```

The Release is written by the `release` job in `publish.yml`, after both packages are on npm, and
uses GitHub's generated notes: `.github/release.yml` defines the categories and
`.github/scripts/merge-release-notes.mjs` folds in the conventional-commit entries of commits that
have no pull request, so a direct push to `master` still lands under *Features*, *Fixes*,
*Security* or *Refactors* instead of *Other Changes*.

Rules:

- Install the hook once per clone: `git config core.hooksPath .githooks` (`npm install` does it
  through the `prepare` script).
- Versions only go up: npm cannot republish a version, and a tag name cannot be reused.
- A tag deletion push (all-zero sha) is not checked — see `pre-push`.
- `publish.yml` skips a package whose version npm already holds, so a tag pushed after a manual
  publish stays green instead of failing.

## One-time setup (a package that does not exist on npm yet)

Trusted Publishing is registered **per package on npmjs.com**, and npm only offers that page once the
package exists. A brand-new package therefore cannot be published by the workflow: the first version
goes out by hand, and the tag is pushed afterwards.

```sh
npm login                                   # or `npm whoami` to check the token still works
cd packages/ext && npm publish              # piher@X.Y.Z
cd ../.. && npm publish                     # piher-setup@X.Y.Z
git tag -f X.Y.Z && git push && git push --tags   # the workflow finds both versions published
```

Then, for **each** of `piher` and `piher-setup` on npmjs.com → *Settings → Trusted Publishing*:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization / user | `felixzsh` |
| Repository | `piher` |
| Workflow filename | `publish.yml` |
| Environment | *(empty)* |

That pair of registrations is what lets the workflow publish with an OIDC token instead of a stored
secret (`id-token: write`, npm ≥ 11.5 — `publish.yml` installs it). The `repository` field in both
`package.json` files must keep pointing at `github.com/felixzsh/piher`: npm matches it against the
repository that runs the workflow, and provenance is built from it.

Note: Trusted Publishing and provenance from a **private** repository need a paid npm plan; a public
repository needs nothing.

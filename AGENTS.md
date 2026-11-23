# Project Agent Guidelines

## Private / Environment Rules
- If `agents.private.md` exists in the workspace root, read and follow it as well for environment-specific and private deployment rules.

## Migration & Version Compatibility Rule
- **Do NOT bake legacy data/schema/config migration logic into the main application runtime.** Keep `src/` clean and focused on the current version's schema and config structure.
- Any cross-version upgrade or migration (e.g., SQLite `ALTER TABLE` / backfills, config or prompt directory migrations) must be implemented as an external **sidecar** script or upgrade hook rather than inside the runtime startup path.

## Release & Changelog Rule
- **Every formal release (`vX.Y.Z`) MUST include a curated changelog in its GitHub Release notes.** Summarize user-facing features, improvements, and bug fixes since the previous release tag in clear structured sections (do not leave only empty or raw commit dumps).
- When cutting a release, create or update the GitHub Release via `gh release create` / `gh release edit` with the written changelog so `.github/workflows/release.yml` attaches the build artifacts to the curated release notes.

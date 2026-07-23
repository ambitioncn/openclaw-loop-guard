# OpenClaw Loop Guard v0.1.5

This release improves intervention for policy-level tool failures:

- Normalizes repeated memory-write policy failures into one signature even when the agent changes file path or content.
- Normalizes local-media allowed-directory failures the same way.
- Preserves the original params preview for audit while grouping by the stable policy error type.
- Adds regression coverage for changing-params write policy loops.

Validation:

- `npm test` passed.
- `npm run check` passed.
- Verified on `nickv100` with OpenClaw `2026.6.11`.

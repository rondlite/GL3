# Form prefill for the manifest view vocabulary — design spec

**Status:** approved design, pre-implementation.
**Motivation:** field report from the first premium plugin (`@gl3-plugins/fixer`),
2026-08-22.

## 1. The problem

The generic form renderer never prefills. Every `form` node renders with blank
fields, so a settings form's submit posts blanks for everything the operator
didn't re-type — and a route that upserts submitted values silently wipes
stored settings. Changing one number means re-entering all of them.

Every settings-editing admin form on the platform has this exposure today:
bullets, detectives, travel, and the Fixer. The Fixer worked around it in
`0.1.3` with a convention (blank = keep, `(clear)` = reset), which fixes the
data loss but costs the "blank is a meaningful value" semantic and adds a
sentinel every operator must learn per plugin. The platform fix is prefill:
render the form already holding current values, so submitting untouched
fields round-trips them unchanged and plain upsert-all routes become correct
again.

## 2. Design

### Vocabulary: one optional field on the `form` node

```ts
{ kind: "form",
  action: "POST /api/admin/fixer/settings",
  submitLabel: "Save settings",
  valuesSource?: "GET /api/admin/fixer/settings",   // NEW, optional
  fields: [...] }
```

- `valuesSource` names a GET the renderer fetches before first paint of the
  form. The response must carry a `values` object:
  `{ values: Record<string, string> }` — flat, all strings, keyed by field
  `name`. Extra keys are ignored; missing keys leave that field blank.
- The same URL may serve a table and the prefill: `values` can sit alongside
  `rows` in one response, so an existing settings GET adopts prefill by
  adding one object to what it already returns. No second route required.
  This requires two additive shared-schema changes shipped together:
  `TableRowsResponseSchema` (which is `.strict()` and parsed by every table
  and select on mount) gains `values: z.record(z.string()).optional()`, and a
  new `FormValuesResponseSchema = z.object({ values: z.record(z.string()) }).passthrough()`
  is what `FormBlock` parses — tolerant of `rows` riding alongside.
- Absent `valuesSource` (the default), behavior is exactly today's: blank
  form. The field is additive; every existing manifest stays valid.

### Renderer semantics (`apps/web`)

- On mount, fetch `valuesSource` (same client the `table` node's `source`
  uses); populate matching fields by `name` — text/number/money/decimal and
  password as the input's initial value, `select` by matching the option
  whose `valueKey` equals the value, `hidden` fields NOT overridden (their
  declared `value` is the author's contract).
- Refetch after a successful submit, so the form reflects what the server
  actually stored (a clamped or rejected-then-defaulted value shows up
  immediately).
- Fetch failure (403/404/500) degrades to a blank form — the pre-prefill
  behavior, never an error wall. A failed prefill must not block the submit
  path.
- Plugin pages do not use react-query (`PageRenderer.tsx` is plain
  `useState`/`useEffect`/`api()` by design); prefill follows the
  `SelectField` pattern — a cancel-flagged `useEffect` fetch keyed on the
  path plus the page's existing `refetchSignal`, which already increments
  only after a successful action. Because the `form` arm currently renders
  inline in `PageRenderer`'s switch, it is extracted into a `FormBlock`
  component so the effect is per-form.
- Known tradeoff, accepted: `refetchSignal` bumps on ANY successful action on
  the page, and the refetch overwrites the form's fields with the server's
  stored values — an in-progress edit in form A is lost when form B on the
  same page submits. Admin pages are single-operator and this mirrors how
  tables already behave; revisit only if it bites.

### Secrets

Masking stays server-side, where it already lives: a route that masks
`llm_api_key` as `"(set)"` in `values` will see `"(set)"` posted back on an
untouched submit and must keep treating it as "unchanged" (the Fixer's
existing skip-on-mask). Prefill does not change the secret contract; it only
makes the mask visible in the input instead of an empty box.

### Validation (loader)

`validatePlugins`' containment walk gains `valuesSource` beside the existing
`source` / `optionsSource` / `entitySource` checks
(`apps/server/src/plugins/validate.ts:120-141`): it must be a GET under one
of the plugin's `basePaths`, same rule and same error shape as its siblings.

## 3. Touched surfaces, in dependency order

The compat regime is **armed** (first out-of-workspace consumer exists), so
every change here is additive-only, with version bumps and publishes:

1. `@gl3/shared` — `ViewNodeDtoSchema`'s `form` object gains optional
   `valuesSource: z.string().optional()`. The Dto schema is `.strict()` and
   `PluginsPayloadSchema.parse` is all-or-nothing in the browser: **shared
   must ship first**, or a manifest declaring the field takes down the whole
   plugin payload on old clients. Patch bump + publish.
2. `@gl3/plugin-sdk` — `ViewNodeSchema`'s `form` gains the same optional
   field; README documents it; the SDK's own `"@gl3/shared"` range moves to
   the new floor. Patch bump + publish.
   `view-node-parity.test.ts` guards leaf-kind sets, not per-kind fields —
   the parity of THIS field is asserted by a new test case reading both
   schemas' `form` shape (extend the existing parity test rather than
   trusting review).
3. `apps/server` — `validate.ts` containment walk (one arm), plus its test.
4. `apps/web` — the form component in the page renderer
   (`plugins/PageRenderer.tsx` / `plugins/render.ts`): fetch, populate,
   refetch-on-submit, degrade-on-failure.
5. Retrofits, each optional and per-plugin: add `values` to the settings GET
   and `valuesSource` to the form node for **bullets** and **detectives**.
   **Travel is dropped** (amended 2026-08-22): it has no settings form — its
   only prefillable form is a per-row town editor driven by an `id` select,
   which the fetch-on-mount model cannot serve and §4's no-per-field-source
   non-goal excludes; a create form must never be prefilled. Their
   upsert-all POST routes become correct as-is once the form round-trips
   current values.
6. The Fixer (separate repo, separate release): adopt `valuesSource`; keep
   `(clear)` as the reset-to-default sentinel (it still has a job — deleting
   a row to fall back to a default is not expressible by posting any value)
   but blank-means-keep can retire once prefill guarantees blanks no longer
   reach the route from untouched fields. That retirement is a Fixer
   decision, not this spec's.

## 4. Non-goals

- No live-reload of settings (boot-snapshot semantics unchanged; the
  restart-to-apply note stays).
- No per-field `valueSource` — one source per form. A form mixing two
  backends is a smell, not a requirement.
- No rich value types: `values` is strings, matching the renderer's
  everything-is-a-string field contract.
- No change to `optionsSource` (selects' option lists) — only initial
  values.

## 5. Testing

- Shared/SDK: the extended parity case (both `form` schemas accept and
  reject the same shapes).
- Server: validate.ts rejects a `valuesSource` outside `basePaths` and
  accepts the fixer-shaped declaration (unit, in the existing validate
  suite). Non-GET rejection lives in the schemas' `GET_SOURCE_RE`, not in
  validate.ts — the parity test's reject case covers it.
- Web: component test — prefill populates fields, hidden fields untouched,
  fetch failure renders blank, submit refetches. There is no existing form
  component test; the pattern is `markdown-editor.test.ts` (jsdom,
  `createElement` — the `@gl3/web` include glob is `.ts` only) with `fetch`
  stubbed and the router satisfied. The pure-transform cases in
  `plugins-render.test.ts` use whole-object `toEqual` and all six form cases
  change when the instruction gains a key.
- Retrofit proof: one integration test per retrofitted plugin asserting the
  settings GET now carries `values` mirroring the stored rows; their
  existing POST tests already cover upsert-all.
- The four-places rule does not fire (no new `GameEvent` variant), and no
  migration, no lock-graph edge, no new table.

## 6. Rollout order

Shared publish → SDK publish → GL3 server+web on `main` → core-plugin
retrofits (same branch as server+web is fine — workspace consumers resolve
shared/SDK through the workspace) → Fixer adoption against the published
pair. Old Fixer versions keep working throughout: the field is optional and
the renderer change is additive.

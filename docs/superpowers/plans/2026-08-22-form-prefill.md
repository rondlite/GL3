# Form Prefill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `valuesSource` field to the `form` view node so the generic renderer prefills forms with current values, ending the wipe-on-partial-submit flaw in every settings form.

**Architecture:** Additive schema field in `@gl3/shared` (wire) and `@gl3/plugin-sdk` (author-side), a containment-walk arm in the loader's validator, a `FormBlock` extraction + prefill effect in the web renderer, and retrofits for bullets and detectives. Shared ships first; the compat regime is armed, so everything is additive with patch bumps.

**Tech Stack:** zod 3, React (no react-query on plugin pages), vitest (+ jsdom/@testing-library for the one component test).

**Spec:** `docs/superpowers/specs/2026-08-22-form-prefill-design.md` — read it first; it records the accepted tradeoffs (refetch overwrites edits) and the travel drop.

## Global Constraints

- Additive-only: no existing manifest may become invalid; `valuesSource` is `.optional()` everywhere.
- No `any` in `packages/*` — none, not even a cast. ESM, `.js` extensions on relative imports.
- `exactOptionalPropertyTypes` is on: hand-written literal types use `valuesSource?: string | undefined`; the render-instruction layer uses the file's normalise-to-required-nullable convention (`valuesSource: string | null`), never `?:`.
- `apps/web`'s test include glob is `test/**/*.test.ts` — `.ts` only, components tested via `createElement`.
- Order: shared (Task 1) → SDK (Task 2) → server (Task 3) → web (Tasks 4–5) → retrofits (Tasks 6–7) → full verify (Task 8) → publish (Task 9, approval-gated).
- Scoped runs while iterating (`npm run test:related -- <files>`); the merge gate is a bare `npm run verify` with the exit code read from the process, never through a pipe.
- Env for integration tests: `DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3 REDIS_URL=redis://localhost:6379`; also export `MYSQL_ADMIN_URL` per `.env.example` before the full verify (apps/migrate's suite needs it).
- Never run two full suites at once on this machine; check `pgrep -fa vitest` before the gate run.

---

### Task 1: `@gl3/shared` — wire schema + response schemas

**Files:**
- Modify: `packages/shared/src/dto/plugins.ts` (form leaf ~line 137-172; `TableRowsResponseSchema` ~line 355)
- Modify: `packages/shared/package.json` (version 0.2.0 → 0.2.1)
- Test: `packages/shared/test/form-values-response.test.ts` (new; glob include, no registration needed)

**Interfaces:**
- Produces: `ViewNodeDtoSchema`'s form accepts optional `valuesSource` (GET-shaped); `TableRowsResponseSchema` accepts optional `values: Record<string,string>`; new export `FormValuesResponseSchema` (`{ values: Record<string,string> }`, passthrough) + type `FormValuesResponse`. Tasks 2 (parity), 5 (FormBlock), 6-7 (retrofit tests) consume these exact names.

- [ ] **Step 1: Write the failing test** `packages/shared/test/form-values-response.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FormValuesResponseSchema,
  TableRowsResponseSchema,
  ViewNodeDtoSchema,
} from "../src/index.js";

describe("form prefill wire schemas", () => {
  it("form accepts an optional GET-shaped valuesSource and rejects a POST one", () => {
    const base = {
      kind: "form", action: "POST /api/admin/fixer/settings", submitLabel: "Save",
      fields: [{ name: "pool_size", label: "Offers per town", type: "text" }],
    };
    expect(ViewNodeDtoSchema.safeParse(base).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse({ ...base, valuesSource: "GET /api/admin/fixer/settings" }).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse({ ...base, valuesSource: "POST /api/admin/fixer/settings" }).success).toBe(false);
  });

  it("TableRowsResponse tolerates values riding alongside rows", () => {
    const body = { rows: [{ key: "cost", label: "Cost", value: "500" }], values: { cost: "500" } };
    expect(TableRowsResponseSchema.safeParse(body).success).toBe(true);
    expect(TableRowsResponseSchema.safeParse({ rows: [] }).success).toBe(true);
  });

  it("FormValuesResponse requires values and tolerates rows alongside", () => {
    expect(FormValuesResponseSchema.safeParse({ values: { a: "1" }, rows: [] }).success).toBe(true);
    expect(FormValuesResponseSchema.safeParse({ rows: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project @gl3/shared test/form-values-response.test.ts` (from repo root: `npm run test:related -- packages/shared/test/form-values-response.test.ts` also works). Expected: FAIL (`FormValuesResponseSchema` not exported; `valuesSource` rejected by strict form).

- [ ] **Step 3: Implement.** In `packages/shared/src/dto/plugins.ts`:

(a) In the form leaf (the `z.object({ kind: z.literal("form"), ... }).strict()` member), add after `submitLabel: z.string(),`:

```ts
    // Optional prefill: a GET whose response's `values` object seeds the
    // form's fields by name. Same GET-only rule and containment treatment as
    // `table.source` — it fetches on mount and must never mutate.
    valuesSource: z.string().regex(GET_SOURCE_RE, "valuesSource must be `GET /absolute/path`").optional(),
```

(b) Extend `TableRowsResponseSchema` and add the new schema beside it:

```ts
export const TableRowsResponseSchema = z.object({
  rows: z.array(z.record(z.string())),
  // A settings GET may carry the form-prefill map alongside its table rows;
  // tables ignore it, FormBlock reads it. Optional so every existing
  // response stays valid.
  values: z.record(z.string()).optional(),
}).strict();
export type TableRowsResponse = z.infer<typeof TableRowsResponseSchema>;

/**
 * What a form's `valuesSource` GET must return. Passthrough, not strict:
 * the same URL may also serve `rows` (and anything else) — prefill only
 * cares that `values` is present and string-valued.
 */
export const FormValuesResponseSchema = z.object({
  values: z.record(z.string()),
}).passthrough();
export type FormValuesResponse = z.infer<typeof FormValuesResponseSchema>;
```

(c) Confirm both new exports reach `packages/shared/src/index.ts` (the dto barrel — follow how `TableRowsResponseSchema` is re-exported and mirror it).

(d) Bump `packages/shared/package.json` version to `0.2.1`.

- [ ] **Step 4: Run the test again** — PASS — then the whole shared project: `npx vitest run --project @gl3/shared`. Expected: all green (the events census is untouched — no `GameEvent` change here).

- [ ] **Step 5: Commit** `feat(shared): valuesSource on form nodes, FormValuesResponse schema`

---

### Task 2: `@gl3/plugin-sdk` — author-side schema + parity + README

**Files:**
- Modify: `packages/plugin-sdk/src/pages.ts` (form member of `leafOptions`, ~line 65-116)
- Modify: `packages/plugin-sdk/test/view-node-parity.test.ts`
- Modify: `packages/plugin-sdk/README.md` (Pages section, ~line 232-246)
- Modify: `packages/plugin-sdk/package.json` (version 0.2.1, shared range `^0.2.1`)

**Interfaces:**
- Consumes: Task 1's shared changes (parity test parses both schemas; `srcAliases` maps both packages to `src/`, so no build step between edits and tests).
- Produces: `ViewNodeSchema` form accepts optional `valuesSource`; the inferred `ViewNode` type carries `valuesSource?: string | undefined` automatically (it derives from `leafOptions`).

- [ ] **Step 1: Write the failing parity cases** — append inside the existing `describe` in `packages/plugin-sdk/test/view-node-parity.test.ts`:

```ts
  // Property-level parity for the prefill field, same rationale as
  // `table.rowActions` above: both leaves are `.strict()`, so a field one
  // copy lacks takes down the whole payload in the browser.
  it("accepts `form.valuesSource` in both the SDK and on the wire", () => {
    const node = {
      kind: "form",
      action: "POST /api/admin/example/settings",
      submitLabel: "Save",
      valuesSource: "GET /api/admin/example/settings",
      fields: [{ name: "pool_size", label: "Offers per town", type: "text" }],
    };
    expect(ViewNodeSchema.safeParse(node).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse(node).success).toBe(true);
  });

  // First reject-parity case: prefill fetches on mount, so a mutating verb
  // must fail in BOTH copies — a drift where one accepts POST would let a
  // page mutate on render on whichever side is looser.
  it("rejects a non-GET `form.valuesSource` in both the SDK and on the wire", () => {
    const node = {
      kind: "form",
      action: "POST /api/admin/example/settings",
      submitLabel: "Save",
      valuesSource: "POST /api/admin/example/settings",
      fields: [{ name: "pool_size", label: "Offers per town", type: "text" }],
    };
    expect(ViewNodeSchema.safeParse(node).success).toBe(false);
    expect(ViewNodeDtoSchema.safeParse(node).success).toBe(false);
  });
```

- [ ] **Step 2: Run** `npx vitest run --project @gl3/plugin-sdk test/view-node-parity.test.ts`. Expected: FAIL — the SDK schema rejects `valuesSource` (accept case), while the reject case half-passes; both must go green together.

- [ ] **Step 3: Implement.** In `packages/plugin-sdk/src/pages.ts`, in the form member of `leafOptions`, add after `submitLabel: z.string(),`:

```ts
      // Optional prefill: a GET whose response's `values` object seeds the
      // form's fields by name (`{ values: Record<string, string> }`,
      // `FormValuesResponseSchema` in @gl3/shared). Same GET-only rule and
      // loader containment treatment as `table.source`.
      valuesSource: z
        .string()
        .regex(GET_SOURCE_RE, "valuesSource must be `GET /absolute/path`")
        .optional(),
```

(`ViewNode` needs no hand edit — the leaf half is inferred from `leafOptions`.)

- [ ] **Step 4:** In `packages/plugin-sdk/README.md`'s Pages section, after the existing vocabulary prose, add:

```markdown
A `form` node may declare `valuesSource: "GET /api/..."` — the renderer
fetches it before first paint and seeds the fields by `name` from the
response's `values` object (`{ values: Record<string, string> }`; the same
URL may also serve a table's `rows`). Untouched fields then round-trip
their current values on submit, so an upsert-all settings route no longer
wipes what the operator didn't retype. Omit it and the form renders blank,
exactly as before. Secrets stay masked server-side: return the mask in
`values` and treat it as "unchanged" when it comes back.
```

- [ ] **Step 5:** Bump `packages/plugin-sdk/package.json`: `"version": "0.2.1"`, `"@gl3/shared": "^0.2.1"`.

- [ ] **Step 6: Run** the SDK project: `npx vitest run --project @gl3/plugin-sdk`. Expected: all green, including the typecheck project half. **Commit** `feat(sdk): valuesSource on form nodes, parity-tested`

---

### Task 3: Loader containment walk

**Files:**
- Modify: `apps/server/src/plugins/validate.ts` (form arm ~line 118-125; docblock ~line 92-108)
- Test: `apps/server/test/plugin-validate.test.ts` (already in `@gl3/server:unit`'s include — no workspace edit)

**Interfaces:**
- Consumes: SDK schema from Task 2 (via `srcAliases` — source, not dist).
- Produces: an out-of-basePaths `valuesSource` is a boot failure naming the source, same shape as `optionsSource`'s.

- [ ] **Step 1: Write the failing tests** — append beside the existing `optionsSource` pair in `apps/server/test/plugin-validate.test.ts` (the plugin under test claims `/api/hello`; use the same `withPage` helper):

```ts
  it("accepts a form's valuesSource inside the plugin's basePaths", () => {
    const manifest = withPage({
      kind: "form",
      action: "POST /api/hello/settings",
      submitLabel: "Save",
      valuesSource: "GET /api/hello/settings",
      fields: [{ name: "cost", label: "Cost", type: "money" }],
    });
    expect(() => validatePlugins([manifest])).not.toThrow();
  });

  // `valuesSource` fetches on mount exactly like `table.source` — an
  // uncontained one would let a page read any endpoint in the app.
  it("rejects a form's out-of-scope valuesSource, naming the source", () => {
    const manifest = withPage({
      kind: "form",
      action: "POST /api/hello/settings",
      submitLabel: "Save",
      valuesSource: "GET /api/bank/accounts",
      fields: [{ name: "cost", label: "Cost", type: "money" }],
    });
    expect(() => validatePlugins([manifest])).toThrow(/GET \/api\/bank\/accounts/);
  });
```

- [ ] **Step 2: Run** `npm run test:related -- apps/server/test/plugin-validate.test.ts`. Expected: the reject case FAILS (nothing collects `valuesSource` yet); the accept case passes.

- [ ] **Step 3: Implement** — in `viewActions`' `case "form":` arm, after the `optionsSource` loop, following the `assetBinder` optional-field pattern:

```ts
        // The prefill source fetches on mount exactly like `table.source`,
        // so it is contained the same way. Absent on forms without prefill.
        if (node.valuesSource !== undefined) actions.push(node.valuesSource);
```

Update the walk's docblock sentence that counts source-carrying kinds so it stays true (it currently says "Three of the ten node kinds carry one" — restate to match reality after this change; count the kinds, don't guess).

- [ ] **Step 4: Run the file again** — both green. **Commit** `feat(server): contain form valuesSource in the plugin validator`

---

### Task 4: Web transform layer

**Files:**
- Modify: `apps/web/src/plugins/render.ts` (instruction type ~line 26; form branch ~line 93-118)
- Test: `apps/web/test/plugins-render.test.ts` (six existing form cases use whole-object `toEqual` — they all change)

**Interfaces:**
- Consumes: nothing new (transform reads raw nodes).
- Produces: `RenderInstruction`'s form variant gains `valuesSource: string | null` (house convention: required-nullable, never `?:`). Task 5's `FormBlock` reads exactly this.

- [ ] **Step 1: Update the instruction type:**

```ts
  | { kind: "form"; action: string; submitLabel: string; valuesSource: string | null; fields: FormField[] }
```

- [ ] **Step 2: Update the form branch's return:**

```ts
    return [{
      kind: "form",
      action: String(node.action),
      submitLabel: String(node.submitLabel),
      valuesSource: typeof node.valuesSource === "string" ? node.valuesSource : null,
      fields,
    }];
```

- [ ] **Step 3: Fix the six broken `toEqual` cases** in `apps/web/test/plugins-render.test.ts` (each expected form object gains `valuesSource: null`), and add one new case:

```ts
  it("carries a form's valuesSource through, normalised to null when absent", () => {
    const out = renderNode({
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      valuesSource: "GET /api/x/values",
      fields: [{ name: "amount", label: "Amount", type: "money" as const }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      valuesSource: "GET /api/x/values",
      fields: [{ name: "amount", label: "Amount", type: "money" }],
    }]);
  });
```

- [ ] **Step 4: Run** `npm run test:related -- apps/web/test/plugins-render.test.ts` — all green (7 form cases). **Commit** `feat(web): valuesSource on the form render instruction`

---

### Task 5: `FormBlock` extraction + prefill effect + component test

**Files:**
- Modify: `apps/web/src/plugins/PageRenderer.tsx` (extract the inline `case "form":` arm ~line 552-610 into a `FormBlock` component in the same file, beside `SelectField`)
- Test: `apps/web/test/form-block.test.ts` (new; glob include, `.ts` + `createElement`)

**Interfaces:**
- Consumes: `FormValuesResponseSchema` from `@gl3/shared` (Task 1); `RenderInstruction` form shape (Task 4); existing `api()` client, `formValues`/`setFormValues`/`pending`/`refetchSignal`/`runAction` state in `PageRenderer`.
- Produces: `FormBlock` component — props `{ index: number; inst: Extract<RenderInstruction, { kind: "form" }>; formValues: Record<string, string>; setFormValues: React.Dispatch<React.SetStateAction<Record<string, string>>>; pending: boolean; refetchSignal: number; runAction: (index: number, action: string, body?: Record<string, string>) => Promise<void> }`.

- [ ] **Step 1: Extract `FormBlock`** — move the JSX from the `case "form":` arm verbatim into a new component in `PageRenderer.tsx`, threading the listed props (the arm becomes `return <FormBlock key={index} index={index} inst={inst} formValues={formValues} setFormValues={setFormValues} pending={pending.has(index)} refetchSignal={refetchSignal} runAction={runAction} />;`). No behavior change in this step; run `npm run test:related -- apps/web/test/plugins-render.test.ts` and `npx tsc --build --force apps/web` to prove the refactor compiles clean.

- [ ] **Step 2: Add the prefill effect** at the top of `FormBlock` (mirror `SelectField`'s cancel-flag shape exactly):

```tsx
  const prefillPath = inst.valuesSource === null ? null : inst.valuesSource.replace(/^GET\s+/, "");

  useEffect(() => {
    if (prefillPath === null) return;
    let cancelled = false;
    void api<unknown>(prefillPath)
      .then((body) => {
        if (cancelled) return;
        const parsed = FormValuesResponseSchema.safeParse(body);
        // Degrade to a blank form on any shape mismatch — prefill must never
        // block the submit path.
        if (!parsed.success) return;
        const values = parsed.data.values;
        setFormValues((previous) => {
          const next = { ...previous };
          for (const field of inst.fields) {
            // Hidden fields submit their declared constant; never seeded.
            if (field.type === "hidden") continue;
            const value = values[field.name];
            if (value !== undefined) next[`${index}:${field.name}`] = value;
          }
          return next;
        });
      })
      .catch(() => {
        // Fetch failure degrades to the pre-prefill blank form, silently.
      });
    return () => { cancelled = true; };
  }, [prefillPath, refetchSignal, index, inst.fields, setFormValues]);
```

Import `FormValuesResponseSchema` from `@gl3/shared` at the top of the file, beside the existing `TableRowsResponseSchema` import. (`refetchSignal` in the dep array is what delivers refetch-after-successful-submit for free — it already increments only on success.)

- [ ] **Step 3: Write the component test** `apps/web/test/form-block.test.ts`. Pattern: `markdown-editor.test.ts` header (jsdom pragma, `@testing-library/react`, `createElement`, `afterEach(cleanup)`). Render the full `PageRenderer` (simplest way to get real state wiring) inside a `MemoryRouter`, with `global.fetch` stubbed:

```ts
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageRenderer } from "../src/plugins/PageRenderer.js";
import type { RenderInstruction } from "../src/plugins/render.js";

afterEach(cleanup);

const formInst = (valuesSource: string | null): RenderInstruction[] => [{
  kind: "form", action: "POST /api/admin/x/settings", submitLabel: "Save",
  valuesSource,
  fields: [
    { name: "cost", label: "Cost", type: "money" },
    { name: "mode", type: "hidden", value: "std" },
  ],
}];

function mount(instructions: RenderInstruction[]): void {
  render(createElement(MemoryRouter, null, createElement(PageRenderer, { instructions })));
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = handler(url, init);
    if (body instanceof Error) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe("FormBlock prefill", () => {
  it("seeds fields from valuesSource and never touches hidden fields", async () => {
    stubFetch(() => ({ values: { cost: "500", mode: "EVIL" } }));
    mount(formInst("GET /api/admin/x/settings"));
    await waitFor(() => {
      expect(screen.getByLabelText("Cost")).toHaveProperty("value", "500");
    });
    // hidden field renders nothing and submits its declared constant — no
    // input exists for it to have been seeded into.
    expect(screen.queryByDisplayValue("EVIL")).toBeNull();
  });

  it("renders blank without a valuesSource and fetches nothing", () => {
    const mock = stubFetch(() => ({ values: {} }));
    mount(formInst(null));
    expect(mock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Cost")).toHaveProperty("value", "");
  });

  it("degrades to blank on fetch failure and on shape mismatch", async () => {
    stubFetch(() => new Error("boom"));
    mount(formInst("GET /api/admin/x/settings"));
    await waitFor(() => { expect(screen.getByLabelText("Cost")).toHaveProperty("value", ""); });

    cleanup();
    stubFetch(() => ({ rows: [] })); // no `values` key
    mount(formInst("GET /api/admin/x/settings"));
    await waitFor(() => { expect(screen.getByLabelText("Cost")).toHaveProperty("value", ""); });
  });

  it("refetches after a successful submit and shows what the server stored", async () => {
    let stored = "500";
    stubFetch((url, init) => {
      if (init?.method === "POST") { stored = "750"; return {}; } // server clamps
      return { values: { cost: stored } };
    });
    mount(formInst("GET /api/admin/x/settings"));
    await waitFor(() => { expect(screen.getByLabelText("Cost")).toHaveProperty("value", "500"); });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => { expect(screen.getByLabelText("Cost")).toHaveProperty("value", "750"); });
  });
});
```

Adjust selectors to what the component actually renders (`getByLabelText` works because fields render `<label><span>…</span><input/></label>`; if the nesting defeats it, fall back to `container.querySelector('input[name="cost"]')`). If `api()` requires an auth token from `localStorage`, stub `tokenStore` the way the client reads it (check `apps/web/src/api/client.ts` and satisfy it — jsdom provides `localStorage`).

- [ ] **Step 4: Run** `npm run test:related -- apps/web/test/form-block.test.ts` — all four green. Then the whole web project: `npx vitest run --project @gl3/web`. **Commit** `feat(web): FormBlock with valuesSource prefill`

---

### Task 6: Retrofit — bullets options form

**Files:**
- Modify: `packages/plugins/bullets/src/index.ts` (`adminOptionsListRoute` ~line 84-100; the options form node ~line 192-200)
- Test: extend `apps/server/test/admin-bullets.test.ts` (already registered in the `@gl3/server` project)

**Interfaces:**
- Consumes: shared's `values` tolerance on `TableRowsResponseSchema` (Task 1) — the same URL feeds the page's table.
- Produces: `GET /api/admin/bullets/options` responds `{ rows, values }` where `values` is keyed by the FORM FIELD NAMES (camelCase), not the stored setting keys.

Two traps, both from the exploration and both must be honored:
- `rows[].key` are stored keys (`stock_min_per_hour`) but the form posts camelCase names (`stockMinPerHour`) — build `values` from the `config` object, not from `rows`.
- `maxCost`/`maxBuy` display `"unlimited"` in `rows` when null; `values` must carry `""` for null, or the next submit posts the literal string `"unlimited"` into `bullets.max_cost`.

- [ ] **Step 1: Failing test** — append to `apps/server/test/admin-bullets.test.ts`, following its existing boot/auth helpers (read the file's own idiom for making an admin request):

```ts
  it("options GET carries form-name-keyed values for prefill, blank for unlimited", async () => {
    // (use the file's existing admin-authenticated GET helper for
    //  /api/admin/bullets/options)
    const body = /* parsed response */;
    expect(body.values).toMatchObject({
      stockMinPerHour: expect.stringMatching(/^\d+$/),
      stockMaxPerHour: expect.stringMatching(/^\d+$/),
      maxStock: expect.stringMatching(/^\d+$/),
      maxCost: "",   // unlimited must prefill as blank, never "unlimited"
      maxBuy: "",
    });
  });
```

Replace the two comment placeholders with the file's real helper calls — the existing options-GET test in that file shows the exact invocation; copy it.

- [ ] **Step 2: Implement** — in `adminOptionsListRoute`'s handler, extend the return:

```ts
    return {
      status: 200,
      body: {
        rows: OPTION_LABELS.map(([field, key, label]) => {
          const value = config[field];
          return { key, label, value: value === null ? "unlimited" : value.toString() };
        }),
        // Prefill map for the options form: keyed by the FORM field names
        // (camelCase config fields), with null → "" so "unlimited" the
        // display word never round-trips into a stored setting.
        values: {
          stockMinPerHour: config.stockMinPerHour.toString(),
          stockMaxPerHour: config.stockMaxPerHour.toString(),
          maxStock: config.maxStock.toString(),
          maxCost: config.maxCost === null ? "" : config.maxCost.toString(),
          maxBuy: config.maxBuy === null ? "" : config.maxBuy.toString(),
        },
      },
    };
```

(Verify the five `config` field names against `readBulletSettings`' return type in `packages/plugins/bullets/src/settings.ts` — use the actual names, these five are from the form node.)

- [ ] **Step 3:** Add to the options form node (NOT the stock form — a per-location setter must not prefill):

```ts
          { kind: "form", action: "POST /api/admin/bullets/options", submitLabel: "Update options",
            valuesSource: "GET /api/admin/bullets/options", fields: [
```

- [ ] **Step 4: Run** `npm run test:related -- apps/server/test/admin-bullets.test.ts` — green. **Commit** `feat(bullets): prefill the options form`

---

### Task 7: Retrofit — detectives settings form

**Files:**
- Modify: `packages/plugins/detectives/src/index.ts` (`adminSettingsListRoute` ~line 314-333; form node ~line 367-373)
- Test: extend `apps/server/test/admin-detectives.test.ts` (already registered)

**Interfaces:**
- Consumes: Task 1's schemas. The handler already builds the exact `values` object internally.

- [ ] **Step 1: Failing test** — append to `apps/server/test/admin-detectives.test.ts`, using its existing admin-GET helper:

```ts
  it("settings GET carries a values map matching the stored rows", async () => {
    const body = /* the file's existing settings-GET helper, parsed */;
    expect(Object.keys(body.values).sort()).toEqual(
      ["cost", "duration", "expire", "wealth_cap_multiplier", "wealth_percent"],
    );
    for (const row of body.rows) {
      expect(body.values[row.key]).toBe(row.value);
    }
  });
```

Replace the comment placeholder with the file's real helper call (its existing settings-GET test shows it).

- [ ] **Step 2: Implement** — the handler already computes `values`; change its return from
`body: { rows: SETTING_LABELS.map(...) }` to:

```ts
      body: {
        rows: SETTING_LABELS.map(([key, label]) => ({ key, label, value: values[key] })),
        // The same map, exposed for form prefill — field names on the admin
        // form already equal these keys exactly.
        values,
      },
```

- [ ] **Step 3:** Add `valuesSource: "GET /api/admin/detectives/settings",` to the settings form node (after `submitLabel`).

- [ ] **Step 4: Run** `npm run test:related -- apps/server/test/admin-detectives.test.ts` — green. **Commit** `feat(detectives): prefill the settings form`

---

### Task 8: Merge gate — bare full verify

**Files:** none.

- [ ] **Step 1:** Confirm nothing else is running: `pgrep -fa vitest` (empty), and check `select datname from pg_database where datname like 'gl3_tmpl%'` shows no foreign template churn mid-run.

- [ ] **Step 2:** Export `DATABASE_URL`, `REDIS_URL`, `MYSQL_ADMIN_URL` per `.env.example`, then:

```bash
npm run verify > /tmp/verify-prefill.log 2>&1; echo "exit=$?"
```

Run the two commands as SEPARATE tool invocations if the harness wraps compound commands — the exit code must come from `npm run verify`'s own process status, and any non-zero exit is a failure even if every test passed (unhandled rejections have shipped as green summaries before).

- [ ] **Step 3:** Also run the image-parity check the CI build performs: `npx tsc --build --force apps/server/tsconfig.json` — expected exit 0.

- [ ] **Step 4:** On green: no commit (this task produces no diff). On red: stop, diagnose (rerun the failing file standalone AND at the merge base before accepting any environmental story — the manifest-census lesson).

---

### Task 9: Publish the pair (manual approval gate)

**Files:** none.

- [ ] **Step 1:** Registry + `main` check (version collisions with concurrent sessions are a recorded recurring problem):

```bash
npm view @gl3/shared versions --registry https://npm.gl3.dev
npm view @gl3/plugin-sdk versions --registry https://npm.gl3.dev
git show origin/main:packages/shared/package.json | grep '"version"'
git show origin/main:packages/plugin-sdk/package.json | grep '"version"'
```

Expected: registry maxima `0.2.0`/`0.2.0`; if `0.2.1` is already taken on either, re-bump past the maximum and update the SDK's shared range to match before publishing.

- [ ] **Step 2: STOP — get Ron's explicit approval** to publish `@gl3/shared@0.2.1` then `@gl3/plugin-sdk@0.2.1`.

- [ ] **Step 3:** Publish, shared first:

```bash
npm publish -w packages/shared --registry https://npm.gl3.dev
npm publish -w packages/plugin-sdk --registry https://npm.gl3.dev
```

- [ ] **Step 4:** Verify both `npm view` at the new versions. The Fixer's adoption (add `values` to its settings GET, `valuesSource` to its form, decide `(clear)`'s future) is a separate release in its own repo, out of this plan's scope.

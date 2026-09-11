import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defineProps, field } from "@renderyes/site-sdk";
import { defineHostComponent } from "../src/define-host-component.js";
import { ViewProvider } from "../src/provider.js";

/**
 * Two shapes look alike and only one belongs in the browser.
 *
 * `defineComponent` and the `create*Definition` helpers return the server's
 * half — the semantic contract published in the catalog. `defineHostComponent`
 * returns that plus the renderer. Putting a definition in `components` reached
 * A2UI as an `undefined` implementation and surfaced, at the visitor's first
 * page load, as "Cannot read properties of undefined (reading 'name')" — which
 * names nothing and points nowhere. The publish script accepts the definition
 * too, so nothing upstream caught it either.
 */
const registered = defineHostComponent({
  id: "TicketList",
  version: "1.0.0",
  description: "Support tickets as a list, one row per ticket.",
  props: defineProps({ heading: field.string({ default: "Tickets" }) }),
  dataSlots: {
    tickets: { accepts: [{ dataTypeId: "Ticket", shapes: ["collection"] }] },
  },
  component: () => null,
});

// The server's half: an id, props and a renderer, and no implementation.
const definition = {
  id: "TicketChart",
  version: "1.0.0",
  description: "Tickets over time as a line chart.",
  props: { jsonSchema: {}, safeParse: () => ({ success: true, data: {} }) },
  renderer: { component: "TicketChart", props: {} },
  dataSlots: { tickets: { accepts: [{ dataTypeId: "Ticket", shapes: ["collection"] }] } },
};

function mount(components: unknown[]) {
  return render(
    <ViewProvider
      config={{
        serviceUrl: "https://intent.example",
        catalogId: "support-assist",
        components: components as never,
      }}
    >
      <div />
    </ViewProvider>,
  );
}

describe("what ViewProvider accepts in components", () => {
  it("refuses a component definition, and says which half it is", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => mount([registered, definition])).toThrow(/is a component definition/);
      expect(() => mount([registered, definition])).toThrow(/"TicketChart"/);
      // The remedy must name the call that produces the right value.
      expect(() => mount([registered, definition])).toThrow(/defineHostComponent/);
    } finally {
      errors.mockRestore();
    }
  });

  it("refuses an entry with no renderer at all, by position when it has no id", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => mount([registered, { nonsense: true }])).toThrow(/at index 1/);
      expect(() => mount([registered, { nonsense: true }])).toThrow(/no renderer/);
    } finally {
      errors.mockRestore();
    }
  });

  it("accepts a properly registered component", () => {
    expect(() => mount([registered])).not.toThrow();
  });
});

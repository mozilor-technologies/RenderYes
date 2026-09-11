import Ajv2020 from "ajv/dist/2020.js";
import type { JsonValue, PropsContract, PropsValidationIssue } from "@renderyes/core";

const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });

/**
 * Rebuilds a validating `PropsContract` from a component's serialized JSON
 * Schema alone.
 *
 * A host's original component registration validates props with a live Zod
 * schema (`safeParse`), but a live validator function cannot survive
 * serialization across the wire — only its `.jsonSchema` output can. This is
 * needed the moment a component crosses a network boundary: a host frontend
 * publishing its UI catalog to the RenderYes service, which then validates
 * planner-set props against the exact same contract using Ajv instead of Zod.
 */
export function propsContractFromJsonSchema(
  schema: Record<string, JsonValue>,
): PropsContract {
  const validate = ajv.compile(schema);
  return {
    jsonSchema: schema,
    safeParse(value: unknown) {
      // Ajv applies defaults in place; clone so repeated validation of the
      // same literal never depends on a previous call's mutation.
      const data = JSON.parse(JSON.stringify(value ?? {})) as Record<string, JsonValue>;
      if (validate(data)) {
        return { success: true, data };
      }
      const issues: PropsValidationIssue[] = (validate.errors ?? []).map((error) => ({
        path: (error.instancePath || "").split("/").filter(Boolean),
        message: error.message ?? "Invalid value",
      }));
      return { success: false, issues };
    },
  };
}

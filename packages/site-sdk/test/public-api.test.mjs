import assert from "node:assert/strict";
import test from "node:test";
import * as siteSdk from "@renderyes/site-sdk";

const publicFunctions = [
  "compilePlanDataSurfaceMessages",
  "compileSurfaceMessages",
  "defineComponent",
  "defineProps",
  "defineSite",
  "defineSource",
  "defineSurface",
  "defineTheme",
  "resolveSource",
  "resolveSourceSync",
  "projectPlanDataModel",
  "themeToCssVariables",
  "toSiteManifest",
  "toSourceSnapshot",
  "validatePlanDataBindings",
];

test("exports the integration surface from the package root", () => {
  for (const name of publicFunctions) {
    assert.equal(
      typeof siteSdk[name],
      "function",
      `${name} must be exported from @renderyes/site-sdk`,
    );
  }
  assert.equal(typeof siteSdk.field, "object");
});

import { describe, it, expect } from "vitest";
import { compileI18nPaths, applyLabels } from "../../src/i18n/label-walker.js";
import { i18nField, i18nArrayField } from "../../src/i18n/schema-helpers.js";

// Helper to build a clean schema object (no cached Symbol) for each test
function buildSchema(properties) {
  return {
    type: "object",
    properties,
  };
}

describe("compileI18nPaths", () => {
  it("returns hasI18n: false and empty paths for a schema with no x-i18n annotations", () => {
    const schema = buildSchema({
      id: { type: "string" },
      name: { type: "string" },
    });
    const result = compileI18nPaths(schema);
    expect(result.hasI18n).toBe(false);
    expect(result.paths).toEqual([]);
  });

  it("detects a single i18n field", () => {
    const schema = buildSchema({
      ...i18nField("category", "trainingCategory"),
    });
    const result = compileI18nPaths(schema);
    expect(result.hasI18n).toBe(true);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatchObject({
      path: ["category"],
      namespace: "trainingCategory",
      isArray: false,
    });
  });

  it("detects a nullable i18n field", () => {
    const schema = buildSchema({
      ...i18nField("bodySegment", "bodySegment", { nullable: true }),
    });
    const result = compileI18nPaths(schema);
    expect(result.paths[0].nullable).toBe(true);
  });

  it("detects an array-of-strings i18n field", () => {
    const schema = buildSchema({
      ...i18nArrayField("roles", "userRole"),
    });
    const result = compileI18nPaths(schema);
    expect(result.hasI18n).toBe(true);
    expect(result.paths[0]).toMatchObject({
      path: ["roles"],
      namespace: "userRole",
      isArray: true,
    });
  });

  it("recurses into array-of-objects and builds wildcard paths", () => {
    const schema = {
      type: "object",
      properties: {
        trainings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ...i18nField("category", "trainingCategory"),
            },
          },
        },
      },
    };
    const result = compileI18nPaths(schema);
    expect(result.paths[0].path).toEqual(["trainings", "*", "category"]);
  });

  it("recurses into nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        training: {
          type: "object",
          properties: {
            ...i18nField("category", "trainingCategory"),
          },
        },
      },
    };
    const result = compileI18nPaths(schema);
    expect(result.paths[0].path).toEqual(["training", "category"]);
  });

  it("caches the result via Symbol on the schema object", () => {
    const schema = buildSchema({
      ...i18nField("category", "trainingCategory"),
    });
    const first = compileI18nPaths(schema);
    const second = compileI18nPaths(schema);
    expect(first).toBe(second); // same reference
  });

  it("throws in dev mode when *Label sibling is missing", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      const schemaWithoutLabel = {
        type: "object",
        properties: {
          // Manually declare x-i18n WITHOUT the label sibling
          category: { type: "string", "x-i18n": "trainingCategory" },
          // categoryLabel is intentionally missing
        },
      };
      expect(() => compileI18nPaths(schemaWithoutLabel)).toThrow(
        /categoryLabel/,
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("throws in dev mode when *Label sibling is missing for array field", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      const schemaWithoutLabel = {
        type: "object",
        properties: {
          roles: {
            type: "array",
            items: { type: "string", "x-i18n": "userRole" },
          },
          // rolesLabel is intentionally missing
        },
      };
      expect(() => compileI18nPaths(schemaWithoutLabel)).toThrow(/rolesLabel/);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

describe("applyLabels", () => {
  it("writes a translated label sibling for a scalar field", () => {
    const schema = buildSchema({
      ...i18nField("category", "trainingCategory"),
    });
    const payload = { category: "strength", categoryLabel: "" };
    applyLabels(payload, schema, "en-US");
    expect(payload.categoryLabel).toBe("Strength");
  });

  it("writes null to *Label sibling when raw value is null", () => {
    const schema = buildSchema({
      ...i18nField("bodySegment", "bodySegment", { nullable: true }),
    });
    const payload = { bodySegment: null, bodySegmentLabel: "" };
    applyLabels(payload, schema, "pt-BR");
    expect(payload.bodySegmentLabel).toBeNull();
  });

  it("skips label when field is not present in payload", () => {
    const schema = buildSchema({
      ...i18nField("category", "trainingCategory"),
    });
    const payload = { name: "Test" }; // 'category' not present
    applyLabels(payload, schema, "pt-BR");
    expect(payload.categoryLabel).toBeUndefined();
  });

  it("translates each element of an array-of-strings field", () => {
    const schema = buildSchema({ ...i18nArrayField("roles", "userRole") });
    const payload = { roles: ["trainer", "admin"], rolesLabel: [] };
    applyLabels(payload, schema, "en-US");
    expect(payload.rolesLabel).toEqual(["Trainer", "Administrator"]);
  });

  it("no-ops when schema has zero i18n paths", () => {
    const schema = buildSchema({
      id: { type: "string" },
      name: { type: "string" },
    });
    const payload = { id: "1", name: "Test" };
    const payloadCopy = { ...payload };
    applyLabels(payload, schema, "pt-BR");
    expect(payload).toEqual(payloadCopy); // unchanged
  });

  it("no-ops when payload is null", () => {
    const schema = buildSchema({
      ...i18nField("category", "trainingCategory"),
    });
    // Should not throw
    expect(() => applyLabels(null, schema, "pt-BR")).not.toThrow();
  });

  it("no-ops when payload is undefined", () => {
    const schema = buildSchema({
      ...i18nField("category", "trainingCategory"),
    });
    expect(() => applyLabels(undefined, schema, "pt-BR")).not.toThrow();
  });

  it("applies labels to items in an array-of-objects", () => {
    const schema = {
      type: "object",
      properties: {
        trainings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ...i18nField("category", "trainingCategory"),
            },
          },
        },
      },
    };
    const payload = {
      trainings: [
        { category: "strength", categoryLabel: "" },
        { category: "cardio", categoryLabel: "" },
      ],
    };
    applyLabels(payload, schema, "en-US");
    expect(payload.trainings[0].categoryLabel).toBe("Strength");
    expect(payload.trainings[1].categoryLabel).toBe("Cardio");
  });

  it("is idempotent when run twice", () => {
    const schema = buildSchema({
      ...i18nField("category", "trainingCategory"),
    });
    const payload = { category: "strength", categoryLabel: "" };
    applyLabels(payload, schema, "en-US");
    const labelAfterFirst = payload.categoryLabel;
    applyLabels(payload, schema, "en-US");
    expect(payload.categoryLabel).toBe(labelAfterFirst);
  });
});

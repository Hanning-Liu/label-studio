import React from "react";
import { observable } from "mobx";
import { types } from "mobx-state-tree";
import { render } from "@testing-library/react";
import { BoundarySmoke, boundaryDependencies, customizationBoundary } from "@hanning/frontend/adapters/boundary";

test("Editor discovers and resolves the external customization source", () => {
  expect(customizationBoundary).toBe("hanning");
});

test("external JSX, TypeScript, JSON and styles use the Editor runtime", () => {
  expect(boundaryDependencies).toEqual({ React, observable, types });
  expect(render(<BoundarySmoke />).getByText("hanning").className).toBe("boundary");
});

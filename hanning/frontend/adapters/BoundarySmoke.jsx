import React from "react";
import { observable } from "mobx";
import { types } from "mobx-state-tree";
import styles from "./BoundarySmoke.module.scss";
import { customizationBoundary } from "./boundaryTypes";

export const boundaryDependencies = { React, observable, types };
export const BoundarySmoke = () => <span className={styles.boundary}>{customizationBoundary}</span>;

---
"@pixerate/swift": minor
---

**Swift vector editor: constraints (#624).**

- The constraint solver (`ConstraintSolve.swift`, `ConstraintLM.swift`): every constraint kind (coincident, collinear, concentric, fix, parallel, perpendicular, horizontal, vertical, tangent, smooth, symmetric, equal) and dimension (distance aligned / horizontal / vertical, angle, radius, diameter) over anchors by stable id, handles, segments and round paths, solved per connected component by the damped minimum-norm Gauss–Newton solver, with what was just edited moving least. Ported operation for operation, so solves take the same iterations and land on the same coordinates as the TS core.
- Values are expressions over named parameters (`ConstraintExpr.swift`: `VectorExprEnv`, `evalVectorExpression`, `formatVectorValue`). `addVectorConstraint` names and measures new dimensions and refuses conflicting or redundant constraints, naming the ones involved; `vectorConstraintDof` reports the degrees of freedom left per drawing and per path; `purgeVectorConstraints` drops constraints whose anchors are gone.
- Auto Constrain (`ConstraintAuto.swift`: `inferVectorConstraints`, `autoConstrainVector`, `withVectorAnchorIds`) and the glyph, action and panel data (`ConstraintGlyphs.swift`).
- The controller solves the constraints after every edit and has `addConstraint`, `removeConstraints`, `setConstraintValue`, `autoConstrain`, `getConstraints`, `getParameters`, `getConstraintDof`, `constraintIssues` and `constraintPanel`. The 5 constraint commands run, and the `constraints` scenario passes (11 of 15 vector scenarios).

import { ASTNode, parseFormula } from './parser';
import { colNameToIndex, indexToColName } from './evaluator';

export interface CellDep {
  col: string;
  row: number;
}

export function extractCellDependencies(node: ASTNode): CellDep[] {
  const deps: CellDep[] = [];

  const visit = (curr: ASTNode) => {
    if (curr.type === 'CellRef') {
      deps.push({ col: curr.col, row: curr.row });
    } else if (curr.type === 'Range') {
      const startC = colNameToIndex(curr.startCol);
      const endC = colNameToIndex(curr.endCol);
      const minC = Math.min(startC, endC);
      const maxC = Math.max(startC, endC);
      const minR = Math.min(curr.startRow, curr.endRow);
      const maxR = Math.max(curr.startRow, curr.endRow);

      for (let c = minC; c <= maxC; c++) {
        for (let r = minR; r <= maxR; r++) {
          deps.push({ col: indexToColName(c), row: r });
        }
      }
    } else if (curr.type === 'BinaryOp') {
      visit(curr.left);
      visit(curr.right);
    } else if (curr.type === 'UnaryOp') {
      visit(curr.argument);
    } else if (curr.type === 'FunctionCall') {
      curr.args.forEach(visit);
    }
  };

  visit(node);
  return deps;
}

export class DependencyGraph {
  // Map of cellKey (e.g. "B2") -> Set of cellKeys that this cell depends ON
  private dependencies = new Map<string, Set<string>>();
  // Map of cellKey (e.g. "A1") -> Set of cellKeys that depend ON this cell (dependents)
  private dependents = new Map<string, Set<string>>();

  public setCellFormula(cellKey: string, formulaStr: string | null): void {
    const key = cellKey.toUpperCase();

    // Clear existing dependencies
    const oldDeps = this.dependencies.get(key) || new Set();
    for (const dep of oldDeps) {
      this.dependents.get(dep)?.delete(key);
    }
    this.dependencies.delete(key);

    if (!formulaStr || !formulaStr.startsWith('=')) {
      return;
    }

    try {
      const ast = parseFormula(formulaStr);
      const deps = extractCellDependencies(ast);
      const newDeps = new Set<string>();

      for (const d of deps) {
        const depKey = `${d.col}${d.row}`.toUpperCase();
        newDeps.add(depKey);

        if (!this.dependents.has(depKey)) {
          this.dependents.set(depKey, new Set());
        }
        this.dependents.get(depKey)!.add(key);
      }

      this.dependencies.set(key, newDeps);
    } catch {
      // Syntax errors in formula have no valid dependencies
    }
  }

  public getDependencies(cellKey: string): string[] {
    return Array.from(this.dependencies.get(cellKey.toUpperCase()) || []);
  }

  public getDependents(cellKey: string): string[] {
    return Array.from(this.dependents.get(cellKey.toUpperCase()) || []);
  }

  /**
   * Detects if there is a cycle containing cellKey.
   */
  public hasCycle(cellKey: string): boolean {
    const key = cellKey.toUpperCase();
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string): boolean => {
      visited.add(node);
      recStack.add(node);

      const deps = this.dependencies.get(node) || new Set();
      for (const neighbor of deps) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        } else if (recStack.has(neighbor)) {
          return true;
        }
      }

      recStack.delete(node);
      return false;
    };

    return dfs(key);
  }

  /**
   * Returns cells affected by updating cellKey in topological order.
   */
  public getEvaluationOrder(startCellKey: string): { order: string[]; hasCycle: boolean } {
    const start = startCellKey.toUpperCase();
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const order: string[] = [];
    let cycleDetected = false;

    // Collect all downstream affected cells (reachability via dependents)
    const affected = new Set<string>();
    const collectAffected = (node: string) => {
      affected.add(node);
      const directDependents = this.dependents.get(node) || new Set();
      for (const dep of directDependents) {
        if (!affected.has(dep)) {
          collectAffected(dep);
        }
      }
    };
    collectAffected(start);

    // Topological sort among affected cells
    const visit = (node: string) => {
      if (recStack.has(node)) {
        cycleDetected = true;
        return;
      }
      if (visited.has(node)) return;

      recStack.add(node);
      visited.add(node);

      // Visit nodes that this node depends on, IF they are in the affected set
      const deps = this.dependencies.get(node) || new Set();
      for (const neighbor of deps) {
        if (affected.has(neighbor)) {
          visit(neighbor);
        }
      }

      recStack.delete(node);
      order.push(node);
    };

    for (const node of affected) {
      if (!visited.has(node)) {
        visit(node);
      }
    }

    return { order, hasCycle: cycleDetected };
  }
}

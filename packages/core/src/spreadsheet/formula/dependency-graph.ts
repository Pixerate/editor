import { ASTNode, parseFormula, WHOLE_COLUMN_END_ROW } from './parser';
import { colNameToIndex, indexToColName } from './evaluator';

export interface CellDep {
  col: string;
  row: number;
}

/**
 * Dependency key for "every cell in column `col`", used by whole-column ranges
 * (`A:A`) instead of expanding a million cell keys.
 */
export const columnDependencyKey = (col: string): string => `${col.toUpperCase()}:`;

export function extractCellDependencies(node: ASTNode): CellDep[] {
  const deps: CellDep[] = [];

  const visit = (curr: ASTNode) => {
    if (curr.type === 'CellRef') {
      deps.push({ col: curr.col, row: curr.row });
    } else if (curr.type === 'Range' && curr.endRow >= WHOLE_COLUMN_END_ROW) {
      // Whole-column range: depend on the columns, not on every cell.
      const startC = colNameToIndex(curr.startCol);
      const endC = colNameToIndex(curr.endCol);
      for (let c = Math.min(startC, endC); c <= Math.max(startC, endC); c++) {
        deps.push({ col: indexToColName(c), row: 0 });
      }
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
        const depKey = d.row === 0 ? columnDependencyKey(d.col) : `${d.col}${d.row}`.toUpperCase();
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

  /** Removes every registered formula and dependency. */
  public clear(): void {
    this.dependencies.clear();
    this.dependents.clear();
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

  /**
   * Plans a recalculation over `cellKeys` (and, with `includeDependents`, every
   * cell that transitively depends on them). Returns the keys in evaluation
   * order (dependencies first) and the set of keys that are part of a cycle,
   * which must be marked `#CYCLE!` instead of evaluated. Every member of a
   * cycle is reported, not just the cell that closed it.
   */
  public getEvaluationPlan(
    cellKeys: Iterable<string>,
    options: { includeDependents?: boolean } = {},
  ): { order: string[]; cyclic: Set<string> } {
    const nodes = new Set<string>();
    const queue: string[] = [];
    for (const key of cellKeys) {
      const upper = key.toUpperCase();
      if (!nodes.has(upper)) {
        nodes.add(upper);
        queue.push(upper);
      }
    }
    if (options.includeDependents) {
      while (queue.length > 0) {
        const node = queue.pop()!;
        const direct = [
          ...(this.dependents.get(node) ?? []),
          ...(this.dependents.get(columnDependencyKey(node.replace(/\d+$/, ''))) ?? []),
        ];
        for (const dep of direct) {
          if (!nodes.has(dep)) {
            nodes.add(dep);
            queue.push(dep);
          }
        }
      }
    }

    // Edges point from a cell to the cells it depends on, restricted to `nodes`.
    // Whole-column dependencies expand to the planned cells in that column.
    const neighbors = (node: string): string[] => {
      const result: string[] = [];
      for (const dep of this.dependencies.get(node) ?? []) {
        if (dep.endsWith(':')) {
          const col = dep.slice(0, -1);
          for (const candidate of nodes) {
            if (candidate.replace(/\d+$/, '') === col) result.push(candidate);
          }
        } else if (nodes.has(dep)) {
          result.push(dep);
        }
      }
      return result;
    };

    // Iterative Tarjan: SCCs are emitted dependencies-first.
    const order: string[] = [];
    const cyclic = new Set<string>();
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    let counter = 0;

    for (const root of nodes) {
      if (index.has(root)) continue;
      const work: Array<{ node: string; edges: string[]; next: number }> = [];
      const enter = (node: string) => {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
        work.push({ node, edges: neighbors(node), next: 0 });
      };
      enter(root);

      while (work.length > 0) {
        const frame = work[work.length - 1];
        if (frame.next < frame.edges.length) {
          const target = frame.edges[frame.next++];
          if (!index.has(target)) {
            enter(target);
          } else if (onStack.has(target)) {
            low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
          }
          continue;
        }

        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].node;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
        }

        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          let member: string;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            component.push(member);
          } while (member !== frame.node);

          const isCycle = component.length > 1 || frame.edges.includes(frame.node);
          for (const key of component) {
            order.push(key);
            if (isCycle) cyclic.add(key);
          }
        }
      }
    }

    return { order, cyclic };
  }
}

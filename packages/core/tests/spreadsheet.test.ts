import { describe, it, expect } from 'vitest';
import {
  SpreadsheetController,
  type SpreadsheetDataSource
} from '../src/spreadsheet';

describe('SpreadsheetController', () => {
  it('initializes default columns and rows', () => {
    const ctrl = new SpreadsheetController();
    expect(ctrl.document.columns.length).toBe(4);
    expect(ctrl.document.rows.length).toBe(10);
    expect(ctrl.document.columns[0].key).toBe('A');
  });

  it('sets and evaluates cell formulas reactively', () => {
    const ctrl = new SpreadsheetController();
    const row1 = ctrl.document.rows[0].id;
    const row2 = ctrl.document.rows[1].id;
    const colA = ctrl.document.columns[0].id;
    const colB = ctrl.document.columns[1].id;

    ctrl.setCellValue(row1, colA, '100');
    ctrl.setCellValue(row2, colA, '250');
    ctrl.setCellValue(row1, colB, '=A1 + A2');

    expect(ctrl.getCell(row1, colA).value).toBe('100');
    expect(ctrl.getCell(row1, colB).value).toBe(350);

    // Update A1 and confirm B1 updates
    ctrl.setCellValue(row1, colA, '200');
    expect(ctrl.getCell(row1, colB).value).toBe(450);
  });

  it('supports two-way data source synchronization', async () => {
    const mockTasks = [
      { id: 'task-1', title: 'Task 1', status: 'todo' },
      { id: 'task-2', title: 'Task 2', status: 'in_progress' }
    ];

    let updatedTaskId = '';
    let updatedField = '';
    let updatedValue = '';

    const mockDataSource: SpreadsheetDataSource = {
      id: 'tasks',
      name: 'Tasks',
      getRecords: () => mockTasks,
      getFields: () => [
        { key: 'title', label: 'Title', type: 'string' },
        { key: 'status', label: 'Status', type: 'enum' }
      ],
      updateRecord: (id, field, value) => {
        updatedTaskId = id;
        updatedField = field;
        updatedValue = value;
      }
    };

    const ctrl = new SpreadsheetController({
      dataSources: [mockDataSource],
      primaryDataSourceId: 'tasks',
      document: {
        columns: [
          { id: 'c_title', key: 'A', title: 'Task Title', type: 'bound', binding: { dataSource: 'tasks', field: 'title' } },
          { id: 'c_status', key: 'B', title: 'Status', type: 'bound', binding: { dataSource: 'tasks', field: 'status' } },
          { id: 'c_notes', key: 'C', title: 'Notes', type: 'freeform' }
        ]
      }
    });

    expect(ctrl.document.rows.length).toBe(2);
    expect(ctrl.document.rows[0].recordId).toBe('task-1');
    expect(ctrl.getCell(ctrl.document.rows[0].id, 'c_title').value).toBe('Task 1');
    expect(ctrl.getCell(ctrl.document.rows[1].id, 'c_status').value).toBe('in_progress');

    // Editing bound cell commits back to data source
    ctrl.setCellValue(ctrl.document.rows[0].id, 'c_status', 'done');
    expect(updatedTaskId).toBe('task-1');
    expect(updatedField).toBe('status');
    expect(updatedValue).toBe('done');

    // Freeform cell retains its independent value
    ctrl.setCellValue(ctrl.document.rows[0].id, 'c_notes', 'Needs verification');
    expect(ctrl.getCell(ctrl.document.rows[0].id, 'c_notes').value).toBe('Needs verification');
  });

  it('supports column insertions, deletions, and undo/redo', () => {
    const ctrl = new SpreadsheetController();
    const initialColCount = ctrl.document.columns.length;

    ctrl.insertColumn(1, { title: 'Custom Col' });
    expect(ctrl.document.columns.length).toBe(initialColCount + 1);
    expect(ctrl.document.columns[1].title).toBe('Custom Col');

    ctrl.undo();
    expect(ctrl.document.columns.length).toBe(initialColCount);

    ctrl.redo();
    expect(ctrl.document.columns.length).toBe(initialColCount + 1);
  });

  it('exports and imports TSV data', () => {
    const ctrl = new SpreadsheetController();
    const r0 = ctrl.document.rows[0].id;
    const r1 = ctrl.document.rows[1].id;
    const c0 = ctrl.document.columns[0].id;
    const c1 = ctrl.document.columns[1].id;

    ctrl.setCellValue(r0, c0, '10');
    ctrl.setCellValue(r0, c1, '20');
    ctrl.setCellValue(r1, c0, '30');
    ctrl.setCellValue(r1, c1, '40');

    const tsv = ctrl.exportToTsv();
    expect(tsv).toContain('10\t20');
    expect(tsv).toContain('30\t40');

    const newCtrl = new SpreadsheetController();
    newCtrl.importFromTsv('50\t60\n70\t80');
    expect(newCtrl.getCell(newCtrl.document.rows[0].id, newCtrl.document.columns[0].id).value).toBe('50');
    expect(newCtrl.getCell(newCtrl.document.rows[0].id, newCtrl.document.columns[1].id).value).toBe('60');
  });
});

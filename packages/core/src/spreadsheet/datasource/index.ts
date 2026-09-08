import { SpreadsheetDataSource, SpreadsheetRow, SpreadsheetColumn } from '../types';

export class DataSourceBinder {
  private dataSources = new Map<string, SpreadsheetDataSource>();

  public register(dataSource: SpreadsheetDataSource): void {
    this.dataSources.set(dataSource.id, dataSource);
  }

  public unregister(dataSourceId: string): void {
    this.dataSources.delete(dataSourceId);
  }

  public getDataSource(id: string): SpreadsheetDataSource | undefined {
    return this.dataSources.get(id);
  }

  /**
   * Generates or reconciles spreadsheet rows from a primary data source.
   */
  public syncRows(
    currentRows: SpreadsheetRow[],
    dataSourceId: string
  ): SpreadsheetRow[] {
    const ds = this.dataSources.get(dataSourceId);
    if (!ds) return currentRows;

    const records = ds.getRecords();
    const existingRecordRowMap = new Map<string, SpreadsheetRow>();
    const freeformRows: SpreadsheetRow[] = [];

    for (const row of currentRows) {
      if (row.type === 'record' && row.recordId) {
        existingRecordRowMap.set(row.recordId, row);
      } else {
        freeformRows.push(row);
      }
    }

    const nextRows: SpreadsheetRow[] = [];
    let rowIndex = 0;

    for (const record of records) {
      const existing = existingRecordRowMap.get(record.id);
      nextRows.push({
        id: existing?.id || `row_${record.id}`,
        index: rowIndex++,
        height: existing?.height || 32,
        recordId: record.id,
        type: 'record'
      });
      existingRecordRowMap.delete(record.id);
    }

    // Append preserved freeform rows
    for (const freeform of freeformRows) {
      nextRows.push({
        ...freeform,
        index: rowIndex++
      });
    }

    return nextRows;
  }

  /**
   * Resolves a record's bound field value.
   */
  public resolveBoundValue(
    dataSourceId: string,
    recordId: string,
    field: string
  ): any {
    const ds = this.dataSources.get(dataSourceId);
    if (!ds) return undefined;

    const records = ds.getRecords();
    const record = records.find((r) => r.id === recordId);
    return record ? record[field] : undefined;
  }

  /**
   * Dispatches an update to the underlying data source.
   */
  public async commitBoundValue(
    dataSourceId: string,
    recordId: string,
    field: string,
    value: any
  ): Promise<void> {
    const ds = this.dataSources.get(dataSourceId);
    if (!ds) return;
    await ds.updateRecord(recordId, field, value);
  }
}

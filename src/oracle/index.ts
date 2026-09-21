/**
 * On-chain ZK-compressed scan ledger oracle module.
 */

export {
  type ScanLedgerRecord,
  type CommitScanOptions,
  type CommitScanResult,
  type ReadScanLedgerOptions,
  type ZKOracleClient,
  DEFAULT_ORACLE_PROGRAM_ID,
  SCAN_RECORD_MAGIC,
  serializeScanRecord,
  deserializeScanRecord,
  MockZKOracleClient,
  LightZKOracleClient,
  loadPayerFromEnv,
  commitScan,
  readScanLedger,
} from "./ledger.js";
